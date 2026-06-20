'use strict';
require('dotenv').config();

const express    = require('express');
const axios      = require('axios');
const { google } = require('googleapis');

const app = express();

// ─── Raw body needed for Gmail Pub/Sub signature (must be before json parser) ─
app.use('/webhook/gmail-push', express.raw({ type: '*/*' }));
app.use(express.json());

// ─── Environment Variables ────────────────────────────────────────────────────
const {
  RETELL_API_KEY,
  RETELL_AGENT_ID,
  RETELL_FROM_NUMBER,
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_API_DOMAIN,
  WEBHOOK_SECRET,
  OPENAI_API_KEY,
  // Gmail / Google Workspace OAuth2 for maya@makeyourlabel.com
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,        // OAuth2 refresh token for maya@makeyourlabel.com
  GMAIL_PUBSUB_TOPIC,         // e.g. projects/YOUR_PROJECT/topics/gmail-push
  PORT
} = process.env;

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_CALLS_PER_LEAD     = 3;
const POST_CALL_GAP_MS       = 2 * 60 * 1000;
const LOCK_SAFETY_TIMEOUT_MS = 20 * 60 * 1000;
const DAILY_REQUEUE_MAX      = 2000;
const MAYA_EMAIL             = 'maya@makeyourlabel.com';

const FOLLOWUP_ELIGIBLE_STATUSES = new Set([
  'No Answer', 'Voicemail', 'Callback Requested',
  'Follow-Up Scheduled', 'Call Initiated', 'Failed', 'Call Failed'
]);
const TERMINAL_STATUSES = new Set([
  'Interested', 'Not Interested', 'Max Calls Reached'
]);
const DO_NOT_CALL_LEAD_STATUSES = new Set([
  'Contacted', 'Onboarded'
]);

function isDoNotCallStatus(leadStatus) {
  return DO_NOT_CALL_LEAD_STATUSES.has((leadStatus || '').trim());
}
// ─── Gmail API Client ────────────────────────────────────────────────────────
// Uses OAuth2 with maya@makeyourlabel.com credentials stored as env vars.
// GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN must be set.
function getGmailClient() {
  const auth = new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

// ─── Gmail: Send reply from maya@makeyourlabel.com ────────────────────────────
// Constructs a proper RFC 2822 email and sends via Gmail API.
// threadId keeps it in the same Gmail thread so it appears as a reply.
async function sendGmailReply({ to, toName, subject, bodyText, bodyHtml, threadId, inReplyToMsgId }) {
  const gmail      = getGmailClient();
  const replySubj  = subject.startsWith('Re:') ? subject : 'Re: ' + subject;
  const boundary   = 'boundary_' + Date.now();
  const msgId      = '<' + Date.now() + '.maya@makeyourlabel.com>';

  let raw =
    'From: MAYA | MakeYourLabel <' + MAYA_EMAIL + '>\r\n' +
    'To: ' + (toName ? toName + ' <' + to + '>' : to) + '\r\n' +
    'Subject: ' + replySubj + '\r\n' +
    'Message-ID: ' + msgId + '\r\n' +
    (inReplyToMsgId ? 'In-Reply-To: ' + inReplyToMsgId + '\r\nReferences: ' + inReplyToMsgId + '\r\n' : '') +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: multipart/alternative; boundary="' + boundary + '"\r\n' +
    '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: text/plain; charset=UTF-8\r\n\r\n' +
    bodyText + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: text/html; charset=UTF-8\r\n\r\n' +
    bodyHtml + '\r\n' +
    '--' + boundary + '--';

  // Base64url encode
  const encodedMsg = Buffer.from(raw).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const sendParams = { userId: 'me', requestBody: { raw: encodedMsg } };
  if (threadId) sendParams.requestBody.threadId = threadId;

  const sent = await gmail.users.messages.send(sendParams);
  console.log('[gmail] Reply sent. messageId=' + (sent.data && sent.data.id));
  return sent.data;
}

// ─── Gmail: Send initial outbound email (booking link) ───────────────────────
async function sendGmailBookingEmail(leadName, leadEmail) {
  const firstName = (leadName || '').split(' ')[0] || leadName;
  const bodyText =
    'Hi ' + firstName + ',\n\n' +
    'Thank you for your interest in MakeYourLabel.\n\n' +
    'Please complete your onboarding here:\nhttps://start.makeyourlabel.com/\n\n' +
    'If you have any questions, just reply to this email — I read every one.\n\n' +
    'Regards,\nMAYA\nMakeYourLabel';
  const bodyHtml =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.7;max-width:600px;">' +
    '<p>Hi ' + firstName + ',</p>' +
    '<p>Thank you for your interest in MakeYourLabel.</p>' +
    '<p><a href="https://start.makeyourlabel.com/" style="background:#000;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-weight:bold;">Start Onboarding</a></p>' +
    '<p>If you have any questions, just reply to this email — I read every one.</p>' +
    '<br><p>Regards,<br><strong>MAYA</strong><br>MakeYourLabel</p></div>';

  await sendGmailReply({
    to      : leadEmail,
    toName  : leadName,
    subject : 'Get Started with MakeYourLabel',
    bodyText,
    bodyHtml,
    threadId: null,
    inReplyToMsgId: null
  });
}
// ─── Gmail: Watch inbox via Pub/Sub (call once to start push notifications) ───
// Sets up Gmail push notifications. Must be renewed every 7 days (we auto-renew).
let gmailWatchExpiry = 0;
async function renewGmailWatch() {
  if (!GMAIL_PUBSUB_TOPIC) {
    console.warn('[gmail-watch] GMAIL_PUBSUB_TOPIC not set — skipping watch setup');
    return;
  }
  try {
    const gmail = getGmailClient();
    const res = await gmail.users.watch({
      userId     : 'me',
      requestBody: {
        topicName  : GMAIL_PUBSUB_TOPIC,
        labelIds   : ['INBOX'],
        labelFilterBehavior: 'INCLUDE'
      }
    });
    gmailWatchExpiry = parseInt(res.data.expiration, 10);
    console.log('[gmail-watch] Watch set. historyId=' + res.data.historyId +
      ' expires=' + new Date(gmailWatchExpiry).toISOString());
    // Renew 1 hour before expiry (watch lasts 7 days max)
    const renewIn = Math.max(0, gmailWatchExpiry - Date.now() - 3600000);
    setTimeout(renewGmailWatch, renewIn);
  } catch (e) {
    console.error('[gmail-watch] Failed:', e.message);
    // Retry in 30 minutes if it failed
    setTimeout(renewGmailWatch, 30 * 60 * 1000);
  }
}

// Track the last Gmail historyId we processed to avoid duplicate processing
let lastHistoryId = null;

// ─── Gmail: Read unread reply emails since a historyId ───────────────────────
async function fetchNewInboundEmails(startHistoryId) {
  const gmail = getGmailClient();
  // List history changes since our last known historyId
  let histRes;
  try {
    histRes = await gmail.users.history.list({
      userId         : 'me',
      startHistoryId : startHistoryId,
      historyTypes   : ['messageAdded'],
      labelId        : 'INBOX'
    });
  } catch (e) {
    // historyId too old → fall back to fetching recent unread
    console.warn('[gmail] History fetch failed (historyId too old?), falling back to recent unread:', e.message);
    return fetchRecentUnread();
  }

  const history  = (histRes.data.history) || [];
  const messages = [];
  for (const h of history) {
    for (const m of (h.messagesAdded || [])) {
      messages.push(m.message);
    }
  }
  return messages;
}

// Fallback: fetch last 5 unread inbox messages
async function fetchRecentUnread() {
  const gmail = getGmailClient();
  const list  = await gmail.users.messages.list({
    userId : 'me',
    q      : 'is:unread in:inbox -from:' + MAYA_EMAIL,
    maxResults: 5
  });
  return (list.data.messages) || [];
}

// ─── Gmail: Get full message content ─────────────────────────────────────────
async function getGmailMessage(messageId) {
  const gmail = getGmailClient();
  const res   = await gmail.users.messages.get({
    userId: 'me',
    id    : messageId,
    format: 'full'
  });
  return res.data;
}

// ─── Gmail: Mark message as read ─────────────────────────────────────────────
async function markAsRead(messageId) {
  const gmail = getGmailClient();
  await gmail.users.messages.modify({
    userId      : 'me',
    id          : messageId,
    requestBody : { removeLabelIds: ['UNREAD'] }
  });
}

// ─── Gmail: Extract plain text body from message ─────────────────────────────
function extractEmailBody(gmailMsg) {
  const parts = gmailMsg.payload && gmailMsg.payload.parts;
  // Try to get text/plain part first
  if (parts) {
    for (const p of parts) {
      if (p.mimeType === 'text/plain' && p.body && p.body.data) {
        return Buffer.from(p.body.data, 'base64').toString('utf-8');
      }
    }
    // Fall back to text/html
    for (const p of parts) {
      if (p.mimeType === 'text/html' && p.body && p.body.data) {
        return Buffer.from(p.body.data, 'base64').toString('utf-8')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  }
  // Single-part message
  if (gmailMsg.payload && gmailMsg.payload.body && gmailMsg.payload.body.data) {
    return Buffer.from(gmailMsg.payload.body.data, 'base64').toString('utf-8');
  }
  return '';
}

// ─── Gmail: Get header value ──────────────────────────────────────────────────
function getHeader(gmailMsg, name) {
  const headers = (gmailMsg.payload && gmailMsg.payload.headers) || [];
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}
// ─── OpenAI: Generate Maya email reply ───────────────────────────────────────
async function generateMayaReply(leadName, customerMessage, emailHistory) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const firstName    = (leadName || '').split(' ')[0] || 'there';
  const systemPrompt =
    'You are MAYA, the AI assistant for MakeYourLabel — a premium custom label and packaging company.\n' +
    'You are responding to an email from a customer named ' + firstName + '.\n\n' +
    'Your personality:\n' +
    '- Warm, professional, and concise (never more than 4 short paragraphs)\n' +
    '- You focus on helping leads start their onboarding at https://start.makeyourlabel.com/\n' +
    '- If they ask about pricing, MOQ, turnaround, or products: give helpful answers for a custom label company\n' +
    '- If they want to speak to someone: offer to have a team member call them\n' +
    '- If they say not interested: politely acknowledge and close gracefully\n' +
    '- Always sign off as: MAYA | MakeYourLabel\n' +
    '- Never mention you are an AI unless directly asked\n' +
    '- Never write more than 4 paragraphs\n\n' +
    'Onboarding link: https://start.makeyourlabel.com/';

  const messages = [{ role: 'system', content: systemPrompt }];

  if (emailHistory && emailHistory.length > 0) {
    messages.push({
      role   : 'user',
      content: 'Email thread context (most recent last):\n\n' + emailHistory.slice(-6).join('\n\n---\n\n')
    });
    messages.push({
      role   : 'assistant',
      content: 'Got it, I have the thread context.'
    });
  }

  messages.push({
    role   : 'user',
    content: 'Customer reply from ' + firstName + ':\n\n' + customerMessage + '\n\nWrite only the email body (no subject line).'
  });

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model      : 'gpt-4o-mini',
    messages,
    max_tokens : 600,
    temperature: 0.7
  }, {
    headers: {
      Authorization : 'Bearer ' + OPENAI_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  const replyText = res.data.choices[0].message.content.trim();
  const replyHtml =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.7;max-width:600px;">' +
    replyText.split('\n\n').map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('') +
    '</div>';

  return { replyText, replyHtml };
}

// ─── Core: Process one inbound email from a customer ─────────────────────────
// Called both from the Pub/Sub webhook and the fallback poller.
async function processInboundEmail(messageId) {
  let gmailMsg;
  try {
    gmailMsg = await getGmailMessage(messageId);
  } catch (e) {
    console.error('[email] Could not fetch message ' + messageId + ':', e.message);
    return;
  }

  const from       = getHeader(gmailMsg, 'from');
  const subject    = getHeader(gmailMsg, 'subject') || '(no subject)';
  const msgIdHdr   = getHeader(gmailMsg, 'message-id');
  const threadId   = gmailMsg.threadId;

  // Parse sender
  const emailMatch  = from.match(/<([^>]+)>/) || from.match(/([w.+-]+@[w-]+.[w.]+)/);
  const senderEmail = emailMatch ? emailMatch[1].toLowerCase().trim() : '';
  const senderName  = from.includes('<') ? from.split('<')[0].trim().replace(/"/g, '') : senderEmail;

  if (!senderEmail) { console.warn('[email] No sender email, skipping ' + messageId); return; }

  // Skip our own outbound emails
  if (senderEmail.toLowerCase().includes('makeyourlabel.com')) {
    console.log('[email] Skipping internal message ' + messageId);
    return;
  }

  // Skip auto-replies / bounce messages
  const autoReply = getHeader(gmailMsg, 'x-autoreply') || getHeader(gmailMsg, 'auto-submitted');
  if (autoReply && autoReply !== 'no') {
    console.log('[email] Skipping auto-reply from ' + senderEmail);
    return;
  }

  const customerText = extractEmailBody(gmailMsg).slice(0, 4000);
  if (!customerText || customerText.trim().length < 3) {
    console.log('[email] Empty body, skipping ' + messageId);
    return;
  }

  console.log('[email] Processing reply from ' + senderEmail + ' | subject: ' + subject);

  // Mark as read immediately so we don't process it again
  try { await markAsRead(messageId); } catch (_) {}

  // Find lead in Zoho by sender email
  let lead = null;
  try {
    lead = await findZohoLeadByEmail(senderEmail);
    if (lead) console.log('[email] Matched Zoho lead: ' + lead.id + ' ' + (lead.First_Name || '') + ' ' + (lead.Last_Name || ''));
    else      console.log('[email] No Zoho lead for ' + senderEmail + ' — replying anyway');
  } catch (e) {
    console.warn('[email] Zoho lookup failed:', e.message);
  }

  const leadId   = lead ? lead.id : null;
  const leadName = lead
    ? (((lead.First_Name || '') + ' ' + (lead.Last_Name || '')).trim() || senderName)
    : senderName;

  // Load email thread history from Zoho for context
  let emailHistory = [];
  if (lead && lead.AI_Email_Thread) {
    try { emailHistory = JSON.parse(lead.AI_Email_Thread); } catch (_) { emailHistory = []; }
  }
  const shortMsg = customerText.length > 500 ? customerText.slice(0, 500) + ' [...]' : customerText;
  emailHistory.push('Customer (' + new Date().toISOString() + '):\n' + shortMsg);

  // Generate Maya reply via OpenAI
  let replyText = '', replyHtml = '';
  try {
    const reply = await withRetry(() => generateMayaReply(leadName, customerText, emailHistory));
    replyText   = reply.replyText;
    replyHtml   = reply.replyHtml;
    console.log('[email] OpenAI reply ready (' + replyText.length + ' chars)');
  } catch (e) {
    console.error('[email] OpenAI failed:', e.message);
    const fn  = leadName.split(' ')[0] || 'there';
    replyText = 'Hi ' + fn + ',\n\nThank you for your message! We will get back to you shortly.\n\nIn the meantime, you can get started here: https://start.makeyourlabel.com/\n\nRegards,\nMAYA | MakeYourLabel';
    replyHtml = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.7;max-width:600px;"><p>Hi ' + fn + ',</p><p>Thank you for your message! We will get back to you shortly.</p><p><a href="https://start.makeyourlabel.com/" style="background:#000;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-weight:bold;">Get Started</a></p><br><p>Regards,<br><strong>MAYA</strong> | MakeYourLabel</p></div>';
  }

  // Send reply via Gmail
  try {
    await sendGmailReply({ to: senderEmail, toName: senderName, subject, bodyText: replyText, bodyHtml: replyHtml, threadId, inReplyToMsgId: msgIdHdr });
    console.log('[email] Reply sent to ' + senderEmail);
  } catch (e) {
    console.error('[email] Gmail send failed:', e.response ? JSON.stringify(e.response.data) : e.message);
  }

  // Save thread + notes to Zoho
  emailHistory.push('MAYA (' + new Date().toISOString() + '):\n' + replyText);
  if (emailHistory.length > 20) emailHistory = emailHistory.slice(-20);

  if (leadId) {
    try {
      await addZohoEmailNote(leadId, 'IN', subject, shortMsg);
      await addZohoEmailNote(leadId, 'OUT', subject, replyText);
      await updateZohoLead(leadId, {
        AI_Email_Thread    : JSON.stringify(emailHistory),
        AI_Last_Email_Reply: nowISTString()
      });
      console.log('[email] Zoho updated for lead ' + leadId);
    } catch (e) {
      console.error('[email] Zoho update failed:', e.message);
    }
  }
}
// ─── Sequential Call Queue ────────────────────────────────────────────────────
const callQueue = [];
let isCallActive   = false;
let lastCallEndedAt = 0;
let activeCallId   = null;
let activeLockTimer = null;

function enqueueCall(lead, source, priority = 'normal') {
  const already = callQueue.some(item => item.lead.id === lead.id);
  if (already) { console.log('[queue] Lead ' + lead.id + ' already queued (' + source + ')'); return; }
  if (priority === 'high') callQueue.unshift({ lead, source });
  else                     callQueue.push({ lead, source });
  console.log('[queue] Enqueued lead ' + lead.id + ' (' + lead.name + ') src=' + source + ' pri=' + priority + ' qLen=' + callQueue.length);
  processQueue();
}

async function processQueue() {
  if (isCallActive) { console.log('[queue] Call active (call_id=' + activeCallId + '), waiting...'); return; }
  const timeSinceLast = Date.now() - lastCallEndedAt;
  if (lastCallEndedAt > 0 && timeSinceLast < POST_CALL_GAP_MS) {
    const wait = POST_CALL_GAP_MS - timeSinceLast;
    console.log('[queue] Post-call gap: waiting ' + Math.round(wait / 1000) + 's');
    setTimeout(processQueue, wait);
    return;
  }
  while (callQueue.length > 0 && !isCallActive) {
    const { lead, source } = callQueue.shift();
    let eligible = true;
    try {
      const fresh   = await getZohoLead(lead.id);
      const lStatus = (fresh && fresh.Lead_Status || '').trim();
      const aiStat  = (fresh && fresh.AI_Last_Call_Status || '').trim();
      const count   = parseInt((fresh && fresh.AI_Call_Count) || '0', 10);
      if (isDoNotCallStatus(lStatus)) { console.log('[queue] Skip ' + lead.id + ' — Lead_Status=' + lStatus); eligible = false; }
      else if (count >= MAX_CALLS_PER_LEAD) { await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Max Calls Reached' }); eligible = false; }
      else if (TERMINAL_STATUSES.has(aiStat)) { eligible = false; }
      else { if (fresh && fresh.Phone) lead.phone = fresh.Phone; lead._callCount = count; }
    } catch (e) { console.warn('[queue] Re-verify failed for ' + lead.id + ' (proceeding):', e.message); lead._callCount = lead._callCount || 0; }
    if (!eligible) continue;
    isCallActive = true; activeCallId = null;
    try {
      const callData  = await withRetry(() => placeRetellCall(lead));
      activeCallId    = callData.call_id;
      activeLockTimer = setTimeout(() => { console.error('[queue] SAFETY TIMEOUT for call_id=' + activeCallId); callEnded(false); }, LOCK_SAFETY_TIMEOUT_MS);
      const newCount  = (lead._callCount || 0) + 1;
      await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Call Initiated', AI_Last_Call_Date: nowISTString(), AI_Call_Count: newCount });
    } catch (err) {
      console.error('[queue] Call placement failed for lead ' + lead.id + ':', err.response ? JSON.stringify(err.response.data) : err.message);
      try { await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Call Failed' }); } catch (_) {}
      isCallActive = false; activeCallId = null;
    }
  }
  if (callQueue.length === 0) console.log('[queue] Queue empty');
}

function callEnded(crmDone) {
  if (activeLockTimer) { clearTimeout(activeLockTimer); activeLockTimer = null; }
  isCallActive    = false;
  activeCallId    = null;
  lastCallEndedAt = Date.now();
  console.log('[queue] Lock released. crmDone=' + crmDone + ' qLen=' + callQueue.length);
  if (callQueue.length > 0) setTimeout(processQueue, POST_CALL_GAP_MS);
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function nowISTString() {
  const IST_OFFSET_MS = 5.5 * 3600 * 1000;
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().replace('T',' ').replace(/\.\d+Z$/, '') + ' IST';
}

async function withRetry(fn, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt === retries) throw err;
      console.warn('[retry] Attempt ' + attempt + ' failed, retrying in ' + delayMs + 'ms: ' + err.message);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}
// ─── Zoho OAuth ───────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getZohoAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: { refresh_token: ZOHO_REFRESH_TOKEN, client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' }
  });
  if (!res.data.access_token) throw new Error('Zoho token refresh failed: ' + JSON.stringify(res.data));
  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── Zoho CRM: Fetch Lead ─────────────────────────────────────────────────────
async function getZohoLead(leadId) {
  const token   = await getZohoAccessToken();
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const res = await axios.get(baseUrl + '/crm/v3/Leads/' + leadId, { headers: { Authorization: 'Zoho-oauthtoken ' + token } });
  return (res.data && res.data.data && res.data.data[0]) || null;
}

// ─── Zoho CRM: Find Lead by email ────────────────────────────────────────────
async function findZohoLeadByEmail(email) {
  const token   = await getZohoAccessToken();
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const res = await axios.get(baseUrl + '/crm/v3/Leads/search', {
    headers: { Authorization: 'Zoho-oauthtoken ' + token },
    params : { email, fields: 'id,First_Name,Last_Name,Email,Phone,Company,AI_Last_Call_Status,Lead_Status,AI_Email_Thread' }
  });
  return ((res.data && res.data.data) || [])[0] || null;
}

// ─── Zoho CRM: Raw field update ───────────────────────────────────────────────
async function updateZohoLead(leadId, fields) {
  const token   = await getZohoAccessToken();
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const res = await axios.put(baseUrl + '/crm/v3/Leads/' + leadId,
    { data: [{ id: leadId, ...fields }] },
    { headers: { Authorization: 'Zoho-oauthtoken ' + token } }
  );
  const result = res.data && res.data.data && res.data.data[0];
  if (result && result.status === 'error') throw new Error('Zoho field error: ' + JSON.stringify(result));
  return result;
}

// ─── Zoho CRM: Safe update (picklists individually) ──────────────────────────
const PICKLIST_FIELDS = new Set(['AI_Last_Call_Status','Call_Outcome','Meeting_Interested','Booking_Link_Sent']);

async function safeUpdateZohoLead(leadId, fields) {
  const freeFields = {}, picklistFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (PICKLIST_FIELDS.has(k)) picklistFields[k] = v; else freeFields[k] = v;
  }
  if (Object.keys(freeFields).length > 0) {
    try { await updateZohoLead(leadId, freeFields); console.log('[zoho] Free fields written:', Object.keys(freeFields).join(', ')); }
    catch (err) { console.error('[zoho] Free fields FAILED:', err.response ? JSON.stringify(err.response.data) : err.message); }
  }
  for (const [k, v] of Object.entries(picklistFields)) {
    if (!v) continue;
    try { await updateZohoLead(leadId, { [k]: v }); console.log('[zoho] Picklist written: ' + k + '=' + v); }
    catch (err) { console.error('[zoho] Picklist FAILED: ' + k + '=' + v + ':', err.response ? JSON.stringify(err.response.data) : err.message); }
  }
}

// ─── Zoho CRM: Add note ───────────────────────────────────────────────────────
async function addZohoNote(leadId, leadName, callStatus, outcome, transcript, callDate) {
  const token   = await getZohoAccessToken();
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const summary = transcript && transcript.length > 2000 ? transcript.slice(0,2000) + '\n[truncated]' : (transcript || 'No transcript');
  const body = 'Call Date: ' + callDate + '\nLead Name: ' + leadName + '\nCall Status: ' + callStatus + '\nOutcome: ' + outcome + '\n\n--- Transcript ---\n' + summary;
  await axios.post(baseUrl + '/crm/v3/Notes', { data: [{ Note_Title: 'AI Call Summary - ' + callDate, Note_Content: body, Parent_Id: leadId, se_module: 'Leads' }] }, { headers: { Authorization: 'Zoho-oauthtoken ' + token } });
}

async function addZohoEmailNote(leadId, direction, subject, body) {
  const token   = await getZohoAccessToken();
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const content = body.length > 3000 ? body.slice(0,3000) + '\n[truncated]' : body;
  await axios.post(baseUrl + '/crm/v3/Notes', { data: [{ Note_Title: '[Email ' + direction + '] ' + subject, Note_Content: content, Parent_Id: leadId, se_module: 'Leads' }] }, { headers: { Authorization: 'Zoho-oauthtoken ' + token } });
}

// ─── Retell: Place Call ───────────────────────────────────────────────────────
async function placeRetellCall(lead) {
  const res = await axios.post('https://api.retellai.com/v2/create-phone-call', {
    agent_id  : RETELL_AGENT_ID, from_number: RETELL_FROM_NUMBER, to_number: lead.phone,
    retell_llm_dynamic_variables: { lead_id: lead.id, lead_name: lead.name, lead_email: lead.email || '', lead_phone: lead.phone || '', company: lead.company || 'your company', booking_link: 'https://start.makeyourlabel.com/' }
  }, { headers: { Authorization: 'Bearer ' + RETELL_API_KEY } });
  return res.data;
}
// ─── Transcript Analysis ──────────────────────────────────────────────────────
function analyzeTranscript(transcript, callStatus) {
  transcript = transcript || '';
  const lower = transcript.toLowerCase().trim();
  if (!lower || lower.length < 10) return callStatus === 'Voicemail' ? { outcome: 'Voicemail Left', meetingInterested: 'No' } : { outcome: 'No Answer', meetingInterested: 'No' };
  const NEGATIVE = ['not interested','no thank',"don't want",'dont want','please remove','do not call','wrong number','stop calling','not looking','not right now','no, thank'];
  const CALLBACK = ['call me tomorrow','call back tomorrow','call later','try again tomorrow','call me later','call again later','busy right now','call me back','ill call you back',"i'll call you back"];
  const POSITIVE = ['yes i am interested',"yes, i'm interested",'i am interested',"i'm interested",'i would like to','i want to','sounds good','sounds great','tell me more','how does it work','let me book','i will book','sign me up','book a consultation','want to sign up','absolutely interested','of course i want'];
  if (NEGATIVE.some(s => lower.includes(s))) return { outcome: 'Not Interested',     meetingInterested: 'No'  };
  if (CALLBACK.some(s => lower.includes(s))) return { outcome: 'Callback Requested', meetingInterested: 'No'  };
  if (POSITIVE.some(s => lower.includes(s))) return { outcome: 'Interested',         meetingInterested: 'Yes' };
  return { outcome: 'Callback Requested', meetingInterested: 'No' };
}

function getCallStatus(disconnectReason, transcript) {
  const dr = (disconnectReason || '').toLowerCase();
  if (dr === 'machine_detected' || dr === 'voicemail_reached') return 'Voicemail';
  if (dr === 'dial_no_answer'   || dr === 'no_answer')         return 'No Answer';
  if (dr === 'dial_failed'      || dr === 'error')             return 'Failed';
  if ((transcript || '').trim().length >= 100)                  return 'Completed';
  return 'No Answer';
}

// ─── IST helpers ──────────────────────────────────────────────────────────────
const IST_OFFSET_MS   = 5.5 * 3600 * 1000;
const THREE_THIRTY_MS = 3.5 * 3600 * 1000;

function getDelayUntilNext330AMIST() {
  const nowUTC      = Date.now();
  const nowIST      = new Date(nowUTC + IST_OFFSET_MS);
  const midnightIST = Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()) - IST_OFFSET_MS;
  let target = midnightIST + THREE_THIRTY_MS;
  if (nowUTC >= target) target += 24 * 3600 * 1000;
  const delay = target - nowUTC;
  console.log('[scheduler] Next 3:30 AM IST in ' + Math.round(delay/60000) + ' min');
  return delay;
}

function scheduleFollowUpCall(lead, delayMs) {
  console.log('[followup] Will enqueue lead ' + lead.id + ' in ' + Math.round(delayMs/60000) + ' min');
  setTimeout(() => { console.log('[followup] Enqueuing lead ' + lead.id); enqueueCall(lead, 'follow-up', 'normal'); }, delayMs);
}

// ─── Startup recovery scan ────────────────────────────────────────────────────
async function runStartupRecoveryScan() {
  console.log('[startup-recovery] Scanning for missed follow-up leads...');
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  let recovered = 0, skipped = 0;
  try {
    let page = 1;
    while (true) {
      const token = await getZohoAccessToken();
      const r = await axios.get(baseUrl + '/crm/v3/Leads', {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        params : { fields: 'id,First_Name,Last_Name,Phone,Email,Company,AI_Call_Count,AI_Last_Call_Status,Lead_Status,AI_Follow_Up_Scheduled', per_page: 200, page }
      });
      const leads = (r.data && r.data.data) || [];
      if (!leads.length) break;
      for (const lead of leads) {
        const count = parseInt(lead.AI_Call_Count || '0', 10);
        const status = (lead.AI_Last_Call_Status || '').trim();
        const lStatus = (lead.Lead_Status || '').trim();
        const phone = lead.Phone || '';
        if (isDoNotCallStatus(lStatus) || count >= MAX_CALLS_PER_LEAD || TERMINAL_STATUSES.has(status) || !phone || status !== 'Follow-Up Scheduled') { skipped++; continue; }
        const leadObj = { id: lead.id, name: ((lead.First_Name||'')+' '+(lead.Last_Name||'')).trim()||'Valued Lead', phone, email: lead.Email||'', company: lead.Company||'' };
        enqueueCall(leadObj, 'startup-recovery', 'normal');
        console.log('[startup-recovery] Re-enqueued lead ' + lead.id + ' (' + leadObj.name + ')');
        recovered++;
      }
      if (!(r.data && r.data.info && r.data.info.more_records)) break;
      page++;
    }
  } catch (e) { console.error('[startup-recovery] Error:', e.message); }
  console.log('[startup-recovery] Done. recovered=' + recovered + ' skipped=' + skipped);
}
// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 1: Zoho CRM Webhook → new lead → enqueue call
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/zoho-lead', async (req, res) => {
  const { webhook_secret, id, First_Name, Last_Name, Phone, Email, Company } = req.body;
  if (!WEBHOOK_SECRET || webhook_secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!id)    return res.status(400).json({ error: 'Lead id required' });
  if (!Phone) return res.status(400).json({ error: 'Phone required' });
  try {
    const existing = await getZohoLead(id);
    const ls       = (existing && existing.Lead_Status || '').trim();
    const aiStatus = (existing && existing.AI_Last_Call_Status || '').trim();
    const count    = parseInt((existing && existing.AI_Call_Count) || '0', 10);
    if (isDoNotCallStatus(ls))           return res.json({ success: false, skipped: true, reason: 'Lead_Status=' + ls });
    if (count >= MAX_CALLS_PER_LEAD)     return res.json({ success: false, skipped: true, reason: 'Max calls reached' });
    if (TERMINAL_STATUSES.has(aiStatus)) return res.json({ success: false, skipped: true, reason: 'Terminal AI status: ' + aiStatus });
  } catch (fetchErr) { console.warn('[zoho-lead] Could not fetch lead (proceeding):', fetchErr.message); }
  const lead = { id, name: ((First_Name||'')+' '+(Last_Name||'')).trim()||'Valued Lead', phone: Phone, email: Email||'', company: Company||'' };
  enqueueCall(lead, 'new-lead', 'high');
  return res.json({ success: true, message: 'Lead queued for call', leadId: id, queueLen: callQueue.length + (isCallActive ? 1 : 0) });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 2: Retell post-call webhook
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/retell-callback', async (req, res) => {
  const { event, call } = req.body || {};
  if (event !== 'call_ended') return res.json({ ignored: true, event });
  const vars            = (call && call.retell_llm_dynamic_variables) || {};
  const leadId          = vars.lead_id;
  const leadName        = vars.lead_name   || 'Lead';
  const leadEmail       = vars.lead_email  || '';
  const leadPhone       = vars.lead_phone  || '';
  const transcript      = (call && call.transcript)           || '';
  const recordingUrl    = (call && call.recording_url)        || '';
  const transcriptUrl   = (call && call.public_log_url)       || '';
  const disconnectReason = (call && call.disconnection_reason) || 'unknown';
  if (!leadId) return res.status(400).json({ error: 'lead_id missing' });
  const callStatus       = getCallStatus(disconnectReason, transcript);
  const analysis         = analyzeTranscript(transcript, callStatus);
  const outcome          = analysis.outcome;
  const meetingInterested = analysis.meetingInterested;
  const bookingLinkSent  = meetingInterested === 'Yes' ? 'Yes' : 'No';
  callEnded(false);
  res.json({ success: true, leadId, callStatus, outcome, meetingInterested, bookingLinkSent });
  (async () => {
    let currentCallCount = 1, freshPhone = leadPhone, freshCompany = '';
    try {
      const fresh = await getZohoLead(leadId);
      currentCallCount = parseInt((fresh && fresh.AI_Call_Count) || '1', 10);
      if (!freshPhone) freshPhone = (fresh && fresh.Phone) || '';
      freshCompany = (fresh && fresh.Company) || '';
    } catch (e) { console.warn('[retell-callback] Could not fetch lead:', e.message); }
    const callDate = nowISTString();
    await safeUpdateZohoLead(leadId, {
      AI_Last_Call_Status: callStatus, AI_Last_Call_Date: callDate,
      Call_Outcome: outcome, Meeting_Interested: meetingInterested, Booking_Link_Sent: bookingLinkSent,
      Call_Summary: transcript ? (transcript.length > 2000 ? transcript.slice(0,2000)+' [truncated]' : transcript) : '',
      Recording_URL: recordingUrl, Transcript_URL: transcriptUrl, AI_Call_Count: currentCallCount
    });
    try { await addZohoNote(leadId, leadName, callStatus, outcome, transcript, callDate); } catch (e) { console.error('[retell-callback] Note failed:', e.message); }
    const needsFollowUp = FOLLOWUP_ELIGIBLE_STATUSES.has(callStatus);
    if (needsFollowUp && currentCallCount < MAX_CALLS_PER_LEAD) {
      const followLead = { id: leadId, name: leadName, phone: freshPhone, email: leadEmail, company: freshCompany };
      if (followLead.phone) {
        const delayMs   = getDelayUntilNext330AMIST();
        const fireAtStr = new Date(Date.now() + delayMs + IST_OFFSET_MS).toISOString().replace('T',' ').replace(/\.\d+Z$/,'') + ' IST';
        try { await safeUpdateZohoLead(leadId, { AI_Last_Call_Status: 'Follow-Up Scheduled', AI_Follow_Up_Scheduled: fireAtStr }); } catch (e) {}
        scheduleFollowUpCall(followLead, delayMs);
      }
    } else if (needsFollowUp && currentCallCount >= MAX_CALLS_PER_LEAD) {
      try { await safeUpdateZohoLead(leadId, { AI_Last_Call_Status: 'Max Calls Reached' }); } catch (_) {}
    }
    // Send initial booking email via Gmail if interested
    if (meetingInterested === 'Yes' && leadEmail) {
      try { await withRetry(() => sendGmailBookingEmail(leadName, leadEmail)); console.log('[retell-callback] Booking email sent to ' + leadEmail); }
      catch (e) { console.error('[retell-callback] Email failed:', e.message); }
    }
  })();
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 3: Gmail Pub/Sub Push Notification
// Google Cloud Pub/Sub POSTs here when maya@makeyourlabel.com receives an email.
// Body: { "message": { "data": "<base64>", "messageId": "..." }, "subscription": "..." }
// The base64 data decodes to: { "emailAddress": "maya@...", "historyId": "12345" }
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/gmail-push', async (req, res) => {
  // Acknowledge immediately — Pub/Sub will retry if we don't respond 200 fast
  res.status(200).send('ok');

  try {
    const body = req.body;
    // body may be Buffer (raw) or already parsed JSON depending on content-type
    let payload;
    try {
      payload = typeof body === 'string' ? JSON.parse(body) : (Buffer.isBuffer(body) ? JSON.parse(body.toString()) : body);
    } catch (_) { console.warn('[gmail-push] Could not parse body'); return; }

    const msgData = payload && payload.message && payload.message.data;
    if (!msgData) { console.warn('[gmail-push] No message.data in payload'); return; }

    // Decode base64 → { emailAddress, historyId }
    let notification;
    try { notification = JSON.parse(Buffer.from(msgData, 'base64').toString('utf-8')); } catch (_) { return; }
    const historyId = notification && notification.historyId;
    if (!historyId) { console.warn('[gmail-push] No historyId in notification'); return; }

    console.log('[gmail-push] Notification historyId=' + historyId + ' (last known=' + lastHistoryId + ')');

    const startId = lastHistoryId || historyId;
    lastHistoryId  = historyId;   // update for next notification

    // Fetch new messages since last historyId
    const newMessages = await fetchNewInboundEmails(startId);
    console.log('[gmail-push] ' + newMessages.length + ' new message(s) to process');

    for (const msg of newMessages) {
      await processInboundEmail(msg.id);
    }
  } catch (err) {
    console.error('[gmail-push] Error:', err.message);
  }
});
// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 4: Health check
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok', service: 'zoho-retell-middleware', timestamp: new Date().toISOString(),
    queue: { active: isCallActive, activeCallId, pending: callQueue.length, lastCallEnded: lastCallEndedAt ? new Date(lastCallEndedAt).toISOString() : null }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 5: Admin — queue management
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/admin/queue', (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  res.json({ isCallActive, activeCallId, queueLength: callQueue.length, pending: callQueue.map(i => ({ id: i.lead.id, name: i.lead.name, source: i.source })), lastCallEnded: lastCallEndedAt ? new Date(lastCallEndedAt).toISOString() : null });
});
app.post('/admin/queue/clear', (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const cleared = callQueue.length; callQueue.length = 0;
  console.log('[admin] Queue cleared (' + cleared + ' items)');
  res.json({ success: true, cleared });
});
app.post('/admin/queue/release-lock', (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  console.warn('[admin] Manual lock release'); callEnded(true);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 6: Admin — manual requeue trigger
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/admin/run-requeue', async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  res.json({ success: true, message: 'Requeue started' });
  runDailyRequeue().catch(e => console.error('[admin/run-requeue]:', e.message));
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 7: Admin — renew Gmail watch manually
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/admin/renew-gmail-watch', async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  try { await renewGmailWatch(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 8: Admin — backfill AI_Call_Count
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/admin/backfill-call-count', async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const CALLED = new Set(['No Answer','Voicemail','Callback Requested','Call Initiated','Follow-Up Scheduled','Completed','Failed','Busy','Call Failed']);
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  let page = 1, updated = 0, skipped = 0, errors = 0;
  res.json({ success: true, message: 'Backfill started — check logs' });
  try {
    while (true) {
      const token = await getZohoAccessToken();
      const r = await axios.get(baseUrl + '/crm/v3/Leads', { headers: { Authorization: 'Zoho-oauthtoken ' + token }, params: { fields: 'id,First_Name,Last_Name,AI_Call_Count,AI_Last_Call_Status,Lead_Status', per_page: 200, page } });
      const leads = (r.data && r.data.data) || [];
      if (!leads.length) break;
      for (const lead of leads) {
        const status = (lead.AI_Last_Call_Status || '').trim();
        if (isDoNotCallStatus(lead.Lead_Status || '') || !status || !CALLED.has(status) || (lead.AI_Call_Count && parseInt(lead.AI_Call_Count) > 0)) { skipped++; continue; }
        try { await updateZohoLead(lead.id, { AI_Call_Count: 1 }); updated++; await new Promise(r => setTimeout(r, 200)); }
        catch (e) { errors++; }
      }
      if (!(r.data && r.data.info && r.data.info.more_records)) break;
      page++;
    }
  } catch (e) { console.error('[backfill] Fatal:', e.message); }
  console.log('[backfill] Done. updated=' + updated + ' skipped=' + skipped + ' errors=' + errors);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Daily 3:30 AM IST Auto-Requeue
// ═══════════════════════════════════════════════════════════════════════════════
async function runDailyRequeue() {
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  let page = 1, queued = 0, skipped = 0, errors = 0, totalFetched = 0;
  try {
    while (true) {
      const token = await getZohoAccessToken();
      const r = await axios.get(baseUrl + '/crm/v3/Leads', { headers: { Authorization: 'Zoho-oauthtoken ' + token }, params: { fields: 'id,First_Name,Last_Name,Phone,Email,Company,AI_Call_Count,AI_Last_Call_Status,Lead_Status', per_page: 200, page } });
      const leads = (r.data && r.data.data) || [];
      totalFetched += leads.length;
      if (!leads.length) break;
      for (const lead of leads) {
        const count = parseInt(lead.AI_Call_Count||'0',10), status = (lead.AI_Last_Call_Status||'').trim(), phone = lead.Phone||'', lStatus = (lead.Lead_Status||'').trim();
        if (isDoNotCallStatus(lStatus)||count>=MAX_CALLS_PER_LEAD||TERMINAL_STATUSES.has(status)||!phone||(count===0&&!status)||(!FOLLOWUP_ELIGIBLE_STATUSES.has(status)&&status!=='')||callQueue.some(i=>i.lead.id===lead.id)) { skipped++; continue; }
        const leadObj = { id: lead.id, name: ((lead.First_Name||'')+' '+(lead.Last_Name||'')).trim()||'Valued Lead', phone, email: lead.Email||'', company: lead.Company||'' };
        try { enqueueCall(leadObj,'daily-requeue','normal'); await safeUpdateZohoLead(lead.id,{AI_Last_Call_Status:'Follow-Up Scheduled',AI_Follow_Up_Scheduled:nowISTString()}); queued++; }
        catch (err) { errors++; }
      }
      if (!(r.data&&r.data.info&&r.data.info.more_records)||totalFetched>=DAILY_REQUEUE_MAX) break;
      page++;
    }
  } catch (err) { console.error('[daily-requeue] Fatal:', err.message); }
  console.log('[daily-requeue] Done. fetched=' + totalFetched + ' queued=' + queued + ' skipped=' + skipped + ' errors=' + errors);
}
function scheduleDailyRequeue() {
  const delayMs = getDelayUntilNext330AMIST();
  setTimeout(async () => { await runDailyRequeue(); scheduleDailyRequeue(); }, delayMs);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 9: Retell Inbound Phone Call
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/inbound', async (req, res) => {
  const fromNumber = (req.body && req.body.from_number) || '';
  let dynamicVars = { lead_name: 'there', lead_email: '', lead_phone: fromNumber, lead_id: '', company: '' };
  if (fromNumber) {
    try {
      const token = await getZohoAccessToken();
      const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
      const searchRes = await axios.get(baseUrl + '/crm/v3/Leads/search', { headers: { Authorization: 'Zoho-oauthtoken ' + token }, params: { phone: fromNumber, fields: 'id,First_Name,Last_Name,Email,Phone,Company' } });
      const leads = (searchRes.data && searchRes.data.data) || [];
      if (leads.length > 0) {
        const lead = leads[0];
        const fullName = ((lead.First_Name||'')+' '+(lead.Last_Name||'')).trim() || 'there';
        dynamicVars = { lead_name: fullName, lead_email: lead.Email||'', lead_phone: lead.Phone||fromNumber, lead_id: lead.id||'', company: lead.Company||'' };
      }
    } catch (err) { console.error('[inbound] Zoho lookup failed:', err.message); }
  }
  res.json({ dynamic_variables: dynamicVars });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 10: OAuth Callback (one-time Zoho token exchange)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');
  try {
    const r = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, { params: { code, client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, redirect_uri: 'https://zoho-retell-middleware-production.up.railway.app/oauth/callback', grant_type: 'authorization_code' } });
    const rt = r.data.refresh_token;
    return rt ? res.send('<h2>SUCCESS</h2><pre>' + rt + '</pre>') : res.send('<pre>' + JSON.stringify(r.data) + '</pre>');
  } catch (err) { return res.status(500).send('<pre>' + JSON.stringify(err.response ? err.response.data : err.message) + '</pre>'); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════════════════════════
const port = PORT || 3000;
app.listen(port, () => {
  console.log('[server] ─────────────────────────────────────────────');
  console.log('[server] zoho-retell-middleware started on port ' + port);
  console.log('[server] Gmail push     : POST /webhook/gmail-push');
  console.log('[server] Zoho webhook   : POST /webhook/zoho-lead');
  console.log('[server] Retell callback: POST /webhook/retell-callback');
  console.log('[server] Inbound call   : POST /webhook/inbound');
  console.log('[server] Health         : GET  /health');
  console.log('[server] ─────────────────────────────────────────────');
  const REQUIRED = ['RETELL_API_KEY','RETELL_AGENT_ID','RETELL_FROM_NUMBER','ZOHO_CLIENT_ID','ZOHO_CLIENT_SECRET','ZOHO_REFRESH_TOKEN','WEBHOOK_SECRET','GMAIL_CLIENT_ID','GMAIL_CLIENT_SECRET','GMAIL_REFRESH_TOKEN'];
  const missing  = REQUIRED.filter(v => !process.env[v]);
  if (missing.length) console.error('[server] MISSING ENV VARS: ' + missing.join(', '));
  else                console.log('[server] All required env vars present');
  if (!OPENAI_API_KEY)     console.warn('[server] OPENAI_API_KEY not set — Maya email AI disabled');
  if (!GMAIL_PUBSUB_TOPIC) console.warn('[server] GMAIL_PUBSUB_TOPIC not set — Gmail push disabled (email replies will not be received)');
  scheduleDailyRequeue();
  setTimeout(runStartupRecoveryScan, 30 * 1000);
  // Start Gmail watch for push notifications
  renewGmailWatch().catch(e => console.error('[server] Gmail watch setup failed:', e.message));
});

module.exports = app;
