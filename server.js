'use strict';
require('dotenv').config();

const express    = require('express');
const axios      = require('axios');
const nodemailer = require('nodemailer');

// smtp fix applied
const app = express();
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
  MAYA_EMAIL,          // maya@makeyourlabel.com
  MAYA_APP_PASSWORD,
GMAIL_CLIENT_ID,
GMAIL_CLIENT_SECRET,
GMAIL_REFRESH_TOKEN,   // Google Workspace App Password for maya@
  PORT
} = process.env;

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_CALLS_PER_LEAD     = 3;
const POST_CALL_GAP_MS       = 2 * 60 * 1000;
const LOCK_SAFETY_TIMEOUT_MS = 20 * 60 * 1000;
const IMAP_POLL_INTERVAL_MS  = 60 * 1000; // check inbox every 60 seconds
const MAYA_FROM              = 'MAYA | MakeYourLabel <' + (MAYA_EMAIL || 'maya@makeyourlabel.com') + '>';

const TERMINAL_STATUSES = new Set([
  'Interested', 'Not Interested', 'Max Calls Reached'
]);
const DO_NOT_CALL_LEAD_STATUSES = new Set([
  'Contacted', 'Onboarded', 'Attempted to Contact'
]);

function isDoNotCallStatus(leadStatus) {
  return DO_NOT_CALL_LEAD_STATUSES.has((leadStatus || '').trim());
}
// ─── Gmail API Email Sending (replaces SMTP - Railway blocks SMTP ports) ────────────────────
const { google } = require('googleapis');

function getGmailClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  const oauth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, 'https://zoho-retell-middleware-production.up.railway.app/gmail/callback');
  oauth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function makeRawEmail({ from, to, toName, subject, text, html, inReplyTo, references }) {
  const boundary = 'MYL_' + Date.now();
  const toFull = toName ? '"' + toName + '" <' + to + '>' : to;
  let headers = 'From: ' + from + '\r\nTo: ' + toFull + '\r\nSubject: ' + subject + '\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="' + boundary + '"';
  if (inReplyTo) headers += '\r\nIn-Reply-To: ' + inReplyTo;
  if (references) headers += '\r\nReferences: ' + references;
  const raw = headers + '\r\n\r\n--' + boundary + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + (text||'') + '\r\n\r\n--' + boundary + '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' + (html||text||'') + '\r\n\r\n--' + boundary + '--';
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Send email via Gmail API (HTTPS, Railway-safe) ──────────────────────────────────────
async function sendEmail({ to, toName, subject, text, html, inReplyTo, references }) {
  const gmail = getGmailClient();
  const raw = makeRawEmail({ from: MAYA_FROM, to, toName, subject, text, html, inReplyTo, references });
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  console.log('[gmail] Sent to ' + to + ' messageId=' + res.data.id);
  return res.data;
}


// ─── OpenAI: Generate Maya reply ─────────────────────────────────────────────
async function generateMayaReply(leadName, customerMessage, emailHistory) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const firstName = (leadName || '').split(' ')[0] || 'there';
  const systemPrompt =
    'You are MAYA, the AI assistant for MakeYourLabel — a premium custom label and packaging company.\n' +
    'You are replying to an email from a customer named ' + firstName + '.\n\n' +
    'Rules:\n' +
    '- Warm, professional, concise — max 4 short paragraphs\n' +
    '- Always push towards onboarding: https://start.makeyourlabel.com/\n' +
    '- If they ask about pricing/MOQ/turnaround: give helpful general answers for a custom label company\n' +
    '- If they want a call: say a team member will reach out shortly\n' +
    '- If not interested: acknowledge gracefully and close\n' +
    '- Sign off as: MAYA | MakeYourLabel\n' +
    '- Never reveal you are an AI unless directly asked';

  const messages = [{ role: 'system', content: systemPrompt }];

  if (emailHistory && emailHistory.length > 0) {
    messages.push({ role: 'user',      content: 'Thread context (oldest first):\n\n' + emailHistory.slice(-6).join('\n\n---\n\n') });
    messages.push({ role: 'assistant', content: 'I have the thread context.' });
  }
  messages.push({ role: 'user', content: 'Customer reply:\n\n' + customerMessage + '\n\nWrite only the email body (no subject line).' });

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini', messages, max_tokens: 500, temperature: 0.7
  }, { headers: { Authorization: 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' } });

  const replyText = res.data.choices[0].message.content.trim();
  const replyHtml = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.7;max-width:600px;">' +
    replyText.split('\n\n').map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('') + '</div>';
  return { replyText, replyHtml };
}

// ─── Gmail API: Poll inbox for new customer replies ─────────────────────────
// Uses Gmail API (HTTPS) instead of IMAP — Railway-safe, no port issues.
// Fetches UNREAD messages in INBOX every 60s, processes each through OpenAI → reply.
let imapPolling = false;
let processedMessageIds = new Set(); // track already-processed messages this session

async function pollGmailInbox() {
  if (!MAYA_EMAIL || !GMAIL_REFRESH_TOKEN) {
    console.warn('[gmail-poll] MAYA_EMAIL or GMAIL_REFRESH_TOKEN not set — skipping poll');
    return;
  }
  if (imapPolling) { console.log('[gmail-poll] Already polling, skipping'); return; }
  imapPolling = true;
  console.log('[gmail-poll] Checking inbox...');

  try {
    const gmail = getGmailClient();

    // Search for UNREAD messages in INBOX not from ourselves
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread in:inbox -from:maya@makeyourlabel.com -from:me',
      maxResults: 10
    });

    const messages = (listRes.data.messages) || [];
    if (messages.length === 0) {
      console.log('[gmail-poll] No unread messages');
      imapPolling = false;
      return;
    }
    console.log('[gmail-poll] Found ' + messages.length + ' unread message(s)');

    for (const msgRef of messages) {
      const msgId = msgRef.id;
      if (processedMessageIds.has(msgId)) continue; // skip already handled

      try {
        // Fetch full message
        const msgRes = await gmail.users.messages.get({
          userId: 'me',
          id: msgId,
          format: 'full'
        });
        const msg = msgRes.data;
        const headers = msg.payload && msg.payload.headers || [];
        const getHeader = (name) => (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

        const fromRaw = getHeader('From');
        const subject = getHeader('Subject') || '(no subject)';
        const messageId = getHeader('Message-ID') || '';
        const references = getHeader('References') || messageId;
        const autoSubmitted = getHeader('Auto-Submitted');

        // Parse sender
        const emailMatch = fromRaw.match(/<([^>]+)>/) || fromRaw.match(/([\w._%+\-]+@[\w.\-]+\.[a-z]{2,})/i);
        const senderEmail = emailMatch ? emailMatch[1].toLowerCase().trim() : fromRaw.toLowerCase().trim();
        const nameMatch = fromRaw.match(/^"?([^"<]+)"?\s*</);
        const senderName = nameMatch ? nameMatch[1].trim() : senderEmail;

        // Skip own emails and auto-replies
        if (!senderEmail || senderEmail.includes('makeyourlabel.com')) { processedMessageIds.add(msgId); continue; }
        if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') { processedMessageIds.add(msgId); continue; }

        // Extract body text
        let bodyText = '';
        const extractText = (part) => {
          if (!part) return;
          if (part.mimeType === 'text/plain' && part.body && part.body.data) {
            bodyText += Buffer.from(part.body.data, 'base64').toString('utf8');
          }
          if (part.parts) part.parts.forEach(extractText);
        };
        extractText(msg.payload);
        bodyText = bodyText.replace(/\r\n/g, '\n').trim();

        if (!bodyText || bodyText.length < 3) { processedMessageIds.add(msgId); continue; }

        console.log('[gmail-poll] Processing email from ' + senderEmail + ' | ' + subject);

        // Mark as read immediately
        await gmail.users.messages.modify({
          userId: 'me',
          id: msgId,
          requestBody: { removeLabelIds: ['UNREAD'] }
        });

        processedMessageIds.add(msgId);
        await processCustomerEmail({ senderEmail, senderName, subject, bodyText, msgId: messageId, references });

      } catch (msgErr) {
        console.error('[gmail-poll] Error processing message ' + msgRef.id + ':', msgErr.message);
        processedMessageIds.add(msgRef.id); // mark done to avoid retry loop
      }
    }
  } catch (err) {
    console.error('[gmail-poll] Poll error:', err.message);
  }
  imapPolling = false;
}

// Start Gmail API polling loop
function startImapPolling() {
  if (!MAYA_EMAIL || !GMAIL_REFRESH_TOKEN) {
    console.warn('[gmail-poll] Not starting — MAYA_EMAIL or GMAIL_REFRESH_TOKEN missing');
    return;
  }
  console.log('[gmail-poll] Starting inbox poll every ' + (IMAP_POLL_INTERVAL_MS/1000) + 's for ' + MAYA_EMAIL);
  pollGmailInbox(); // run immediately on start
  setInterval(() => { imapPolling = false; pollGmailInbox(); }, IMAP_POLL_INTERVAL_MS);
}

// ─── Send booking email when lead is interested ─────────────────────────────
async function sendBookingEmail(leadName, email) {
  const firstName = (leadName || '').split(' ')[0] || 'there';
  const subject = 'Book Your MakeYourLabel Consultation';
  const text = 'Hi ' + firstName + ',\n\nGreat news! Our team is ready to help you with your custom label and packaging needs.\n\nClick the link below to book your consultation at a time that works for you:\nhttps://start.makeyourlabel.com/\n\nLooking forward to connecting with you!\n\nRegards,\nMAYA | MakeYourLabel';
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.7;max-width:600px;"><p>Hi ' + firstName + ',</p><p>Great news! Our team is ready to help you with your custom label and packaging needs.</p><p><a href="https://start.makeyourlabel.com/" style="background:#000;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-weight:bold;">Book Your Consultation</a></p><p>Looking forward to connecting with you!</p><br><p>Regards,<br><strong>MAYA</strong> | MakeYourLabel</p></div>';
  await sendEmail({ to: email, toName: leadName, subject, text, html });
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
  console.log('[queue] Enqueued ' + lead.id + ' (' + lead.name + ') src=' + source + ' qLen=' + callQueue.length);
  processQueue();
}

async function processQueue() {
  if (isCallActive) return;
  const gap = Date.now() - lastCallEndedAt;
  if (lastCallEndedAt > 0 && gap < POST_CALL_GAP_MS) {
    setTimeout(processQueue, POST_CALL_GAP_MS - gap);
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
      if (isDoNotCallStatus(lStatus))      { eligible = false; }
      else if (count >= MAX_CALLS_PER_LEAD){ await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Max Calls Reached' }); eligible = false; }
      else if (TERMINAL_STATUSES.has(aiStat)) { eligible = false; }
      else { if (fresh && fresh.Phone) lead.phone = fresh.Phone; lead._callCount = count; }
    } catch (e) { lead._callCount = lead._callCount || 0; }
    if (!eligible) continue;
    isCallActive = true; activeCallId = null;
    try {
      const callData  = await withRetry(() => placeRetellCall(lead));
      activeCallId    = callData.call_id;
      activeLockTimer = setTimeout(() => { console.error('[queue] SAFETY TIMEOUT'); callEnded(false); }, LOCK_SAFETY_TIMEOUT_MS);
      await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Call Initiated', AI_Last_Call_Date: nowISTString(), AI_Call_Count: (lead._callCount || 0) + 1 });
    } catch (err) {
      console.error('[queue] Call failed for lead ' + lead.id + ':', err.message);
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

// ─── Utilities ────────────────────────────────────────────────────────────────
function nowISTString() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T',' ').replace(/\.\d+Z$/, '') + ' IST';
}

async function withRetry(fn, retries = 3, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}
// ─── Zoho OAuth ───────────────────────────────────────────────────────────────
let cachedToken = null, tokenExpiry = 0;
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

async function getZohoLead(leadId) {
  const token = await getZohoAccessToken();
  const base  = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const res   = await axios.get(base + '/crm/v3/Leads/' + leadId, { headers: { Authorization: 'Zoho-oauthtoken ' + token } });
  return (res.data && res.data.data && res.data.data[0]) || null;
}

async function findZohoLeadByEmail(email) {
  const token = await getZohoAccessToken();
  const base  = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const res   = await axios.get(base + '/crm/v3/Leads/search', {
    headers: { Authorization: 'Zoho-oauthtoken ' + token },
    params : { email, fields: 'id,First_Name,Last_Name,Email,Phone,Company,AI_Last_Call_Status,Lead_Status,AI_Email_Thread' }
  });
  return ((res.data && res.data.data) || [])[0] || null;
}

async function updateZohoLead(leadId, fields) {
  const token = await getZohoAccessToken();
  const base  = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const res   = await axios.put(base + '/crm/v3/Leads/' + leadId,
    { data: [{ id: leadId, ...fields }] },
    { headers: { Authorization: 'Zoho-oauthtoken ' + token } }
  );
  const result = res.data && res.data.data && res.data.data[0];
  if (result && result.status === 'error') throw new Error('Zoho error: ' + JSON.stringify(result));
  return result;
}

const PICKLIST_FIELDS = new Set(['AI_Last_Call_Status','Call_Outcome','Meeting_Interested','Booking_Link_Sent']);
async function safeUpdateZohoLead(leadId, fields) {
  const free = {}, pick = {};
  for (const [k,v] of Object.entries(fields)) {
    if (v == null) continue;
    if (PICKLIST_FIELDS.has(k)) pick[k] = v; else free[k] = v;
  }
  if (Object.keys(free).length) try { await updateZohoLead(leadId, free); } catch(e) { console.error('[zoho] free fields failed:', e.message); }
  for (const [k,v] of Object.entries(pick)) {
    if (!v) continue;
    try { await updateZohoLead(leadId, { [k]: v }); } catch(e) { console.error('[zoho] picklist failed ' + k + ':', e.message); }
  }
}

async function addZohoNote(leadId, leadName, callStatus, outcome, transcript, callDate) {
  const token = await getZohoAccessToken();
  const base  = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const summary = transcript && transcript.length > 2000 ? transcript.slice(0,2000) + '\n[truncated]' : (transcript || 'No transcript');
  const body    = 'Call Date: ' + callDate + '\nLead: ' + leadName + '\nStatus: ' + callStatus + '\nOutcome: ' + outcome + '\n\n' + summary;
  await axios.post(base + '/crm/v3/Notes', { data: [{ Note_Title: 'AI Call - ' + callDate, Note_Content: body, Parent_Id: leadId, se_module: 'Leads' }] }, { headers: { Authorization: 'Zoho-oauthtoken ' + token } });
}

async function addZohoEmailNote(leadId, direction, subject, body) {
  const token   = await getZohoAccessToken();
  const base    = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const content = body.length > 3000 ? body.slice(0,3000) + '\n[truncated]' : body;
  await axios.post(base + '/crm/v3/Notes', { data: [{ Note_Title: '[Email ' + direction + '] ' + subject, Note_Content: content, Parent_Id: leadId, se_module: 'Leads' }] }, { headers: { Authorization: 'Zoho-oauthtoken ' + token } });
}

async function placeRetellCall(lead) {
  const res = await axios.post('https://api.retellai.com/v2/create-phone-call', {
    agent_id: RETELL_AGENT_ID, from_number: RETELL_FROM_NUMBER, to_number: lead.phone,
    retell_llm_dynamic_variables: { lead_id: lead.id, lead_name: lead.name, lead_email: lead.email||'', lead_phone: lead.phone||'', company: lead.company||'your company', booking_link: 'https://start.makeyourlabel.com/' }
  }, { headers: { Authorization: 'Bearer ' + RETELL_API_KEY } });
  return res.data;
}
// ─── Transcript / Call helpers ────────────────────────────────────────────────
function analyzeTranscript(transcript, callStatus) {
  const lower = (transcript||'').toLowerCase().trim();
  if (!lower || lower.length < 10) return callStatus === 'Voicemail' ? { outcome: 'Voicemail Left', meetingInterested: 'No' } : { outcome: 'No Answer', meetingInterested: 'No' };
  const NEG = ['not interested','no thank',"don't want",'dont want','please remove','do not call','wrong number','stop calling'];
  const CB  = ['call me tomorrow','call back','call later','busy right now','call me back',"i'll call you back"];
  const POS = ['yes i am interested',"i'm interested",'i am interested','i would like to','sounds good','tell me more','how does it work','let me book','sign me up','book a consultation'];
  if (NEG.some(s => lower.includes(s))) return { outcome: 'Not Interested',     meetingInterested: 'No'  };
  if (CB.some(s  => lower.includes(s))) return { outcome: 'Callback Requested', meetingInterested: 'No'  };
  if (POS.some(s => lower.includes(s))) return { outcome: 'Interested',         meetingInterested: 'Yes' };
  return { outcome: 'Callback Requested', meetingInterested: 'No' };
}

function getCallStatus(disconnectReason, transcript) {
const dr = (disconnectReason||'').toLowerCase();
if (dr === 'user_declined' || dr === 'call_rejected' || dr === 'busy') return 'No Answer';
if (dr === 'machine_detected' || dr === 'voicemail_reached') return 'Voicemail';
if (dr === 'dial_no_answer' || dr === 'no_answer') return 'No Answer';
if (dr === 'dial_failed' || dr === 'error') return 'Failed';
if ((transcript||'').trim().length >= 100) return 'Completed';
return 'No Answer';
}

const IST_OFFSET_MS = 5.5 * 3600 * 1000;


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ROUTE 1: Zoho new lead → call
app.post('/webhook/zoho-lead', async (req, res) => {
  const { webhook_secret, id, First_Name, Last_Name, Phone, Email, Company } = req.body;
  if (!WEBHOOK_SECRET || webhook_secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!id || !Phone) return res.status(400).json({ error: 'id and Phone required' });
  try {
    const e = await getZohoLead(id);
    const ls = (e && e.Lead_Status || '').trim(), ai = (e && e.AI_Last_Call_Status || '').trim(), ct = parseInt((e && e.AI_Call_Count)||'0',10);
    if (isDoNotCallStatus(ls))       return res.json({ success: false, reason: 'DNC: ' + ls });
    if (ct >= MAX_CALLS_PER_LEAD)    return res.json({ success: false, reason: 'Max calls' });
    if (TERMINAL_STATUSES.has(ai))   return res.json({ success: false, reason: 'Terminal: ' + ai });
  } catch (_) {}
  enqueueCall({ id, name: ((First_Name||'')+' '+(Last_Name||'')).trim()||'Valued Lead', phone: Phone, email: Email||'', company: Company||'' }, 'new-lead', 'high');
  return res.json({ success: true, leadId: id, queueLen: callQueue.length + (isCallActive ? 1 : 0) });
});

// ROUTE 2: Retell post-call callback
app.post('/webhook/retell-callback', async (req, res) => {
  const { event, call } = req.body || {};
  if (event !== 'call_ended') return res.json({ ignored: true });
  const vars   = (call && call.retell_llm_dynamic_variables) || {};
  const leadId = vars.lead_id;
  if (!leadId) return res.status(400).json({ error: 'lead_id missing' });
  const transcript      = (call && call.transcript)           || '';
  const disconnectReason = (call && call.disconnection_reason) || 'unknown';
  const callStatus       = getCallStatus(disconnectReason, transcript);
  const { outcome, meetingInterested } = analyzeTranscript(transcript, callStatus);
  const bookingLinkSent = meetingInterested === 'Yes' ? 'Yes' : 'No';
  callEnded(false);
  res.json({ success: true, leadId, callStatus, outcome });
  (async () => {
  let count = 1, freshPhone = vars.lead_phone||'', freshCompany = vars.lead_email||'';
  try { const f = await getZohoLead(leadId); count = parseInt((f&&f.AI_Call_Count)||'1',10); if (!freshPhone) freshPhone=(f&&f.Phone)||''; freshCompany=(f&&f.Company)||''; } catch(_) {}
  const callDate = nowISTString();
  // Save call count separately to ensure it always updates
  try { await updateZohoLead(leadId, { AI_Call_Count: count }); } catch(_) {}
  await safeUpdateZohoLead(leadId, { AI_Last_Call_Status: callStatus, AI_Last_Call_Date: callDate, Call_Outcome: outcome, Meeting_Interested: meetingInterested, Booking_Link_Sent: bookingLinkSent, Call_Summary: transcript.slice(0,2000), Recording_URL: (call&&call.recording_url)||'', Transcript_URL: (call&&call.public_log_url)||'' });
  try { await addZohoNote(leadId, vars.lead_name||'Lead', callStatus, outcome, transcript, callDate); } catch(_) {}
    // Follow-up calls DISABLED — no automatic re-calls after call ends
    if (count >= MAX_CALLS_PER_LEAD) {
      try { await safeUpdateZohoLead(leadId, { AI_Last_Call_Status: 'Max Calls Reached' }); } catch(_) {}
    }
  if (meetingInterested === 'Yes' && vars.lead_email) {
    try { await withRetry(() => sendBookingEmail(vars.lead_name||'', vars.lead_email)); console.log('[callback] Booking email sent to ' + vars.lead_email); } catch(e) { console.error('[callback] Email failed:', e.message); }
  }
})()
});

// ROUTE 3: Health
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'zoho-retell-middleware', timestamp: new Date().toISOString(), queue: { active: isCallActive, activeCallId, pending: callQueue.length } }));

// ROUTE 4: Admin queue
app.get('/admin/queue', (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  res.json({ isCallActive, activeCallId, queueLength: callQueue.length, pending: callQueue.map(i => ({ id: i.lead.id, name: i.lead.name, source: i.source })) });
});
app.post('/admin/queue/clear', (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const n = callQueue.length; callQueue.length = 0;
  res.json({ success: true, cleared: n });
});
app.post('/admin/queue/release-lock', (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  callEnded(true); res.json({ success: true });
});
// ROUTE 5: Inbound phone call
app.post('/webhook/inbound', async (req, res) => {
  const from = (req.body && req.body.from_number) || '';
  let dv = { lead_name: 'there', lead_email: '', lead_phone: from, lead_id: '', company: '' };
  if (from) {
    try {
      const token = await getZohoAccessToken();
      const base  = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
      const sr    = await axios.get(base + '/crm/v3/Leads/search', { headers: { Authorization: 'Zoho-oauthtoken ' + token }, params: { phone: from, fields: 'id,First_Name,Last_Name,Email,Phone,Company' } });
      const leads = (sr.data && sr.data.data) || [];
      if (leads.length) { const l = leads[0]; dv = { lead_name: ((l.First_Name||'')+' '+(l.Last_Name||'')).trim()||'there', lead_email: l.Email||'', lead_phone: l.Phone||from, lead_id: l.id||'', company: l.Company||'' }; }
    } catch(_) {}
  }
  res.json({ dynamic_variables: dv });
});

// ROUTE 6b: Gmail OAuth auth URL generator
app.get('/gmail/auth', (req, res) => {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;
  const oauth2Client = new (require('googleapis').google.auth.OAuth2)(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, 'https://zoho-retell-middleware-production.up.railway.app/gmail/callback');
  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/gmail.send'], prompt: 'consent' });
  res.redirect(authUrl);
});

// ROUTE 6c: Gmail OAuth callback - exchanges code for refresh token
app.get('/gmail/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code');
  try {
    const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;
    const oauth2Client = new (require('googleapis').google.auth.OAuth2)(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, 'https://zoho-retell-middleware-production.up.railway.app/gmail/callback');
    const { tokens } = await oauth2Client.getToken(code);
    const rt = tokens.refresh_token;
    return rt ? res.send('<h2 style="font-family:monospace;padding:20px">SUCCESS - Gmail Refresh Token:</h2><pre style="background:#f0f0f0;padding:15px;font-size:14px;word-break:break-all">' + rt + '</pre><p style="font-family:monospace;padding:20px;color:red">Set GMAIL_REFRESH_TOKEN in Railway Variables to the value above, then redeploy.</p>') : res.send('<pre>' + JSON.stringify(tokens) + '</pre>');
  } catch(e) { return res.status(500).send(e.message); }
});

// ROUTE 6: OAuth callback
app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code');
  try {
    const r = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, { params: { code, client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, redirect_uri: 'https://zoho-retell-middleware-production.up.railway.app/oauth/callback', grant_type: 'authorization_code' } });
    const rt = r.data.refresh_token;
    return rt ? res.send('<h2>SUCCESS</h2><pre>' + rt + '</pre>') : res.send('<pre>' + JSON.stringify(r.data) + '</pre>');
  } catch(e) { return res.status(500).send(e.message); }
});
// ─── Daily 3:30 AM IST requeue ────────────────────────────────────────────────

// ─── Start Server ─────────────────────────────────────────────────────────────
const port = PORT || 3000;
app.listen(port, () => {
  console.log('[server] zoho-retell-middleware on port ' + port);
  console.log('[server] Maya email : ' + (MAYA_EMAIL || 'NOT SET'));
  const REQUIRED = ['RETELL_API_KEY','RETELL_AGENT_ID','RETELL_FROM_NUMBER','ZOHO_CLIENT_ID','ZOHO_CLIENT_SECRET','ZOHO_REFRESH_TOKEN','WEBHOOK_SECRET','MAYA_EMAIL','MAYA_APP_PASSWORD','OPENAI_API_KEY'];
  const missing  = REQUIRED.filter(v => !process.env[v]);
  if (missing.length) console.error('[server] MISSING: ' + missing.join(', '));
  else                console.log('[server] All required env vars present');
  // Start IMAP polling for email replies
  setTimeout(startImapPolling, 5000);
});

module.exports = app;
