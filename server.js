'use strict';
require('dotenv').config();

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');

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
  RESEND_API_KEY,
  RETELL_WEBHOOK_SECRET,   // Retell HMAC secret (from Retell dashboard)
  PORT
} = process.env;

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_CALLS_PER_LEAD   = 3;
const POST_CALL_GAP_MS     = 2 * 60 * 1000;   // 2-minute mandatory gap
const LOCK_SAFETY_TIMEOUT_MS = 10 * 60 * 1000; // 10-min deadlock guard
const DAILY_REQUEUE_MAX    = 2000;

// Statuses that warrant a follow-up call
const FOLLOWUP_ELIGIBLE_STATUSES = new Set([
  'No Answer', 'Voicemail', 'Callback Requested',
  'Follow-Up Scheduled', 'Call Initiated', 'Failed', 'Call Failed'
]);

// AI_Last_Call_Status values that mean no further outreach
const TERMINAL_STATUSES = new Set([
  'Interested', 'Not Interested', 'Max Calls Reached'
]);

// Lead_Status values that mean the client is done — never call again
const DO_NOT_CALL_LEAD_STATUSES = new Set([
  'Contacted', 'Onboarded'
]);

function isDoNotCallStatus(leadStatus) {
  return DO_NOT_CALL_LEAD_STATUSES.has((leadStatus || '').trim());
}

// ─── Sequential Call Queue ────────────────────────────────────────────────────
const callQueue   = [];   // Array<{ lead, source }>
let isCallActive  = false;
let lastCallEndedAt = 0;
let activeCallId  = null;
let activeLockTimer = null;

function enqueueCall(lead, source, priority = 'normal') {
  const already = callQueue.some(item => item.lead.id === lead.id);
  if (already) {
    console.log('[queue] Lead ' + lead.id + ' already in queue, skipping (' + source + ')');
    return;
  }
  if (priority === 'high') {
    callQueue.unshift({ lead, source });
  } else {
    callQueue.push({ lead, source });
  }
  console.log('[queue] Enqueued lead ' + lead.id + ' (' + lead.name + ') src=' + source + ' pri=' + priority + ' qLen=' + callQueue.length);
  processQueue();
}

async function processQueue() {
  if (isCallActive) {
    console.log('[queue] Call active (call_id=' + activeCallId + '), waiting...');
    return;
  }
  if (callQueue.length === 0) {
    console.log('[queue] Queue empty');
    return;
  }

  // Enforce 2-minute post-call gap
  const timeSinceLast = Date.now() - lastCallEndedAt;
  if (lastCallEndedAt > 0 && timeSinceLast < POST_CALL_GAP_MS) {
    const wait = POST_CALL_GAP_MS - timeSinceLast;
    console.log('[queue] Post-call gap: waiting ' + Math.round(wait / 1000) + 's');
    setTimeout(processQueue, wait);
    return;
  }

  const { lead, source } = callQueue.shift();
  console.log('[queue] Processing lead ' + lead.id + ' (' + lead.name + ') src=' + source + ' remaining=' + callQueue.length);

  // Re-verify freshness from Zoho before dialling
  try {
    const fresh = await getZohoLead(lead.id);
    const lStatus = (fresh && fresh.Lead_Status          || '').trim();
    const aiStat  = (fresh && fresh.AI_Last_Call_Status  || '').trim();
    const count   = parseInt((fresh && fresh.AI_Call_Count) || '0', 10);

    if (isDoNotCallStatus(lStatus)) {
      console.log('[queue] Skipping ' + lead.id + ' — Lead_Status="' + lStatus + '"');
      return processQueue();
    }
    if (count >= MAX_CALLS_PER_LEAD) {
      console.log('[queue] Skipping ' + lead.id + ' — max calls (' + count + ')');
      await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Max Calls Reached' });
      return processQueue();
    }
    if (TERMINAL_STATUSES.has(aiStat)) {
      console.log('[queue] Skipping ' + lead.id + ' — terminal status "' + aiStat + '"');
      return processQueue();
    }
    // Refresh phone from latest Zoho data
    if (fresh && fresh.Phone) lead.phone = fresh.Phone;
    // Store current count so we can increment it atomically
    lead._callCount = count;
  } catch (e) {
    console.warn('[queue] Re-verify failed for ' + lead.id + ' (proceeding):', e.message);
    lead._callCount = lead._callCount || 0;
  }

  // Acquire lock
  isCallActive  = true;
  activeCallId  = null;

  // Safety: auto-release after 10 min if retell-callback never fires
  activeLockTimer = setTimeout(() => {
    console.error('[queue] SAFETY TIMEOUT: force-releasing lock for lead ' + lead.id);
    callEnded(false);
  }, LOCK_SAFETY_TIMEOUT_MS);

  try {
    const callData = await withRetry(() => placeRetellCall(lead));
    activeCallId = callData.call_id;
    console.log('[queue] Call placed — lead=' + lead.id + ' call_id=' + activeCallId);

    // Increment count atomically from the value we read
    const newCount = (lead._callCount || 0) + 1;

    await safeUpdateZohoLead(lead.id, {
      AI_Last_Call_Status : 'Call Initiated',
      AI_Last_Call_Date   : nowString(),
      AI_Call_Count       : newCount
    });
  } catch (err) {
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('[queue] Call placement failed for lead ' + lead.id + ':', msg);
    try { await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Call Failed' }); } catch (_) {}
    callEnded(false);
  }
}

// Called when call ends (retell-callback or safety timer)
// crmDone: true = CRM writes are finished, false = release lock but CRM may still run
function callEnded(crmDone) {
  if (activeLockTimer) { clearTimeout(activeLockTimer); activeLockTimer = null; }
  isCallActive  = false;
  activeCallId  = null;
  lastCallEndedAt = Date.now();
  console.log('[queue] Lock released. crmDone=' + crmDone + ' qLen=' + callQueue.length + '. Next call in ' + POST_CALL_GAP_MS / 1000 + 's.');
  if (callQueue.length > 0) {
    setTimeout(processQueue, POST_CALL_GAP_MS);
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────
function nowString() {
  // Returns UTC ISO string — store as-is; Zoho accepts ISO datetime
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// ─── Zoho OAuth ───────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getZohoAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await axios.post(
    'https://accounts.zoho.in/oauth/v2/token', null,
    { params: {
        refresh_token : ZOHO_REFRESH_TOKEN,
        client_id     : ZOHO_CLIENT_ID,
        client_secret : ZOHO_CLIENT_SECRET,
        grant_type    : 'refresh_token'
    }}
  );
  if (!res.data.access_token)
    throw new Error('Zoho token refresh failed: ' + JSON.stringify(res.data));
  cachedToken  = res.data.access_token;
  tokenExpiry  = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── Retry ────────────────────────────────────────────────────────────────────
async function withRetry(fn, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt === retries) throw err;
      console.warn('[retry] Attempt ' + attempt + ' failed, retrying in ' + delayMs + 'ms: ' + err.message);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ─── Zoho CRM: Fetch Lead ─────────────────────────────────────────────────────
async function getZohoLead(leadId) {
  const token   = await getZohoAccessToken();
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const res = await axios.get(
    baseUrl + '/crm/v3/Leads/' + leadId,
    { headers: { Authorization: 'Zoho-oauthtoken ' + token } }
  );
  return (res.data && res.data.data && res.data.data[0]) || null;
}

// ─── Zoho CRM: Raw field update ───────────────────────────────────────────────
async function updateZohoLead(leadId, fields) {
  const token   = await getZohoAccessToken();
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const res = await axios.put(
    baseUrl + '/crm/v3/Leads/' + leadId,
    { data: [{ id: leadId, ...fields }] },
    { headers: { Authorization: 'Zoho-oauthtoken ' + token } }
  );
  const result = res.data && res.data.data && res.data.data[0];
  if (result && result.status === 'error')
    throw new Error('Zoho field error: ' + JSON.stringify(result));
  if (result && result.details)
    console.warn('[zoho] Field-level details:', JSON.stringify(result.details));
  return result;
}

// ─── Zoho CRM: Safe update — picklists written individually ──────────────────
// NOTE: Lead_Status is intentionally NOT in this list.
// The AI/Retell system never updates Lead_Status — that is managed by humans in Zoho.
const PICKLIST_FIELDS = new Set([
  'AI_Last_Call_Status', 'Call_Outcome', 'Meeting_Interested', 'Booking_Link_Sent'
]);

async function safeUpdateZohoLead(leadId, fields) {
  const freeFields     = {};
  const picklistFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (PICKLIST_FIELDS.has(k)) picklistFields[k] = v;
    else freeFields[k] = v;
  }
  if (Object.keys(freeFields).length > 0) {
    try {
      await updateZohoLead(leadId, freeFields);
      console.log('[zoho] Free fields written:', Object.keys(freeFields).join(', '));
    } catch (err) {
      console.error('[zoho] Free fields FAILED:', err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
  for (const [k, v] of Object.entries(picklistFields)) {
    if (!v) continue;
    try {
      await updateZohoLead(leadId, { [k]: v });
      console.log('[zoho] Picklist written: ' + k + '="' + v + '"');
    } catch (err) {
      console.error('[zoho] Picklist FAILED: ' + k + '="' + v + '" =>', err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
}

// ─── Zoho CRM: Add note ───────────────────────────────────────────────────────
async function addZohoNote(leadId, leadName, callStatus, outcome, transcript, callDate) {
  const token   = await getZohoAccessToken();
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const title   = 'AI Call Summary - ' + callDate;
  const summary = transcript && transcript.length > 2000
    ? transcript.slice(0, 2000) + '\n[transcript truncated]'
    : (transcript || 'No transcript available');
  const body =
    'Call Date: '    + callDate    + '\n' +
    'Lead Name: '    + leadName    + '\n' +
    'Call Status: '  + callStatus  + '\n' +
    'Outcome: '      + outcome     + '\n\n' +
    '--- Transcript ---\n' + summary;
  await axios.post(
    baseUrl + '/crm/v3/Notes',
    { data: [{ Note_Title: title, Note_Content: body, Parent_Id: leadId, se_module: 'Leads' }] },
    { headers: { Authorization: 'Zoho-oauthtoken ' + token } }
  );
}

// ─── Retell: Place Call ───────────────────────────────────────────────────────
async function placeRetellCall(lead) {
  const res = await axios.post(
    'https://api.retellai.com/v2/create-phone-call',
    {
      agent_id  : RETELL_AGENT_ID,
      from_number: RETELL_FROM_NUMBER,
      to_number : lead.phone,
      retell_llm_dynamic_variables: {
        lead_id    : lead.id,
        lead_name  : lead.name,
        lead_email : lead.email  || '',
        lead_phone : lead.phone  || '',
        company    : lead.company || 'your company',
        booking_link: 'https://start.makeyourlabel.com/'
      }
    },
    { headers: { Authorization: 'Bearer ' + RETELL_API_KEY } }
  );
  return res.data;
}

// ─── Email ────────────────────────────────────────────────────────────────────
async function sendBookingEmail(leadName, leadEmail) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const firstName = (leadName || '').split(' ')[0] || leadName;
  await axios.post('https://api.resend.com/emails', {
    from   : 'MAYA | MakeYourLabel <aditya.raysingh@makeyourlabel.com>',
    to     : [leadEmail],
    subject: 'Get Started with MakeYourLabel',
    text   : 'Hi ' + firstName + ',\n\nThank you for your interest in MakeYourLabel.\n\nPlease complete your onboarding here:\nhttps://start.makeyourlabel.com/\n\nRegards,\nMAYA\nMakeYourLabel',
    html   : '<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.7;max-width:600px;"><p>Hi ' + firstName + ',</p><p>Thank you for your interest in MakeYourLabel.</p><p><a href=\"https://start.makeyourlabel.com/\" style=\"background:#000;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-weight:bold;\">Start Onboarding</a></p><p>If you have any questions, reply to this email.</p><br><p>Regards,<br><strong>MAYA</strong><br>MakeYourLabel</p></div>'
  }, { headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' } });
}

// ─── Transcript Analysis ──────────────────────────────────────────────────────
// Uses phrase-level matching (not single-word) to avoid false positives like
// "yes", "sure", "not sure" triggering Interested incorrectly.
function analyzeTranscript(transcript, callStatus) {
  transcript = transcript || '';
  const lower = transcript.toLowerCase().trim();
  if (!lower || lower.length < 10) {
    return callStatus === 'Voicemail'
      ? { outcome: 'Voicemail Left',  meetingInterested: 'No' }
      : { outcome: 'No Answer',       meetingInterested: 'No' };
  }

  // Negative signals — checked first (higher priority)
  const NEGATIVE = [
    'not interested', 'no thank', "don't want", 'dont want',
    'please remove', 'do not call', 'wrong number', 'stop calling',
    'not looking', 'not right now', 'no, thank'
  ];
  // Callback signals
  const CALLBACK = [
    'call me tomorrow', 'call back tomorrow', 'call later', 'try again tomorrow',
    'call me later', 'call again later', 'busy right now', 'call me back',
    'ill call you back', "i'll call you back"
  ];
  // Positive signals — must be multi-word or context-clear phrases
  const POSITIVE = [
    'yes i am interested', "yes, i'm interested", 'i am interested', "i'm interested",
    'i would like to', 'i want to', 'sounds good', 'sounds great',
    'tell me more', 'how does it work', 'let me book', 'i will book',
    'sign me up', 'book a consultation', 'want to sign up',
    'absolutely interested', 'of course i want'
  ];

  if (NEGATIVE.some(s => lower.includes(s))) return { outcome: 'Not Interested',      meetingInterested: 'No' };
  if (CALLBACK.some(s => lower.includes(s))) return { outcome: 'Callback Requested',  meetingInterested: 'No' };
  if (POSITIVE.some(s => lower.includes(s))) return { outcome: 'Interested',           meetingInterested: 'Yes' };
  return { outcome: 'Callback Requested', meetingInterested: 'No' };
}

// ─── Map Retell disconnect reason → callStatus ────────────────────────────────
function getCallStatus(disconnectReason, transcript) {
  const dr = (disconnectReason || '').toLowerCase();
  if (dr === 'machine_detected' || dr === 'voicemail_reached') return 'Voicemail';
  if (dr === 'dial_no_answer'   || dr === 'no_answer')         return 'No Answer';
  if (dr === 'dial_failed'      || dr === 'error')             return 'Failed';
  // Only treat as Completed if there's a meaningful human conversation (>= 100 chars)
  if ((transcript || '').trim().length >= 100) return 'Completed';
  return 'No Answer';
}

// ─── IST helpers ──────────────────────────────────────────────────────────────
const IST_OFFSET_MS   = 5.5 * 3600 * 1000;
const THREE_THIRTY_MS = 3.5 * 3600 * 1000;

function getDelayUntilNext330AMIST() {
  const nowUTC     = Date.now();
  const nowIST     = new Date(nowUTC + IST_OFFSET_MS);
  const midnightIST = Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()) - IST_OFFSET_MS;
  let target = midnightIST + THREE_THIRTY_MS;
  if (nowUTC >= target) target += 24 * 3600 * 1000;
  const delay = target - nowUTC;
  console.log('[scheduler] Next 3:30 AM IST: ' + new Date(target).toISOString() + ' (in ' + Math.round(delay / 60000) + ' min)');
  return delay;
}

// ─── Schedule a follow-up call ────────────────────────────────────────────────
// NOTE: setTimeout is used here. On Railway restart the timer is lost.
// The daily requeue at 3:30 AM IST acts as the persistent recovery for missed follow-ups.
function scheduleFollowUpCall(lead, delayMs) {
  console.log('[followup] Will enqueue lead ' + lead.id + ' (' + lead.name + ') in ' + Math.round(delayMs / 60000) + ' min');
  setTimeout(() => {
    console.log('[followup] Enqueuing lead ' + lead.id + ' for follow-up');
    enqueueCall(lead, 'follow-up', 'normal');
  }, delayMs);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 1: Zoho CRM Webhook → new lead → enqueue call
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/zoho-lead', async (req, res) => {
  console.log('[zoho-lead] Incoming:', JSON.stringify(req.body, null, 2));

  const { webhook_secret, id, First_Name, Last_Name, Phone, Email, Company } = req.body;

  // Validate webhook secret from body (Zoho custom webhooks send it in body)
  if (!WEBHOOK_SECRET || webhook_secret !== WEBHOOK_SECRET) {
    console.error('[zoho-lead] Unauthorized');
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!id)    return res.status(400).json({ error: 'Lead id required' });
  if (!Phone) {
    console.warn('[zoho-lead] No phone for lead', id);
    return res.status(400).json({ error: 'Phone required' });
  }

  // Gate checks
  try {
    const existing = await getZohoLead(id);
    const ls       = (existing && existing.Lead_Status         || '').trim();
    const aiStatus = (existing && existing.AI_Last_Call_Status || '').trim();
    const count    = parseInt((existing && existing.AI_Call_Count) || '0', 10);

    if (isDoNotCallStatus(ls))          return res.json({ success: false, skipped: true, reason: 'Lead_Status=' + ls });
    if (count >= MAX_CALLS_PER_LEAD)    return res.json({ success: false, skipped: true, reason: 'Max calls reached' });
    if (TERMINAL_STATUSES.has(aiStatus)) return res.json({ success: false, skipped: true, reason: 'Terminal AI status: ' + aiStatus });
  } catch (fetchErr) {
    console.warn('[zoho-lead] Could not fetch lead (proceeding):', fetchErr.message);
  }

  const lead = {
    id,
    name   : ((First_Name || '') + ' ' + (Last_Name || '')).trim() || 'Valued Lead',
    phone  : Phone,
    email  : Email   || '',
    company: Company || ''
  };

  enqueueCall(lead, 'new-lead', 'high');

  return res.json({
    success : true,
    message : 'Lead queued for call',
    leadId  : id,
    queueLen: callQueue.length + (isCallActive ? 1 : 0)
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 2: Retell post-call webhook → release queue lock + update AI Call Tracking
//
// IMPORTANT: This route ONLY updates the "AI Call Tracking" section fields:
//   AI_Last_Call_Status, AI_Last_Call_Date, AI_Call_Count, Meeting_Interested,
//   Call_Outcome, Call_Summary, Booking_Link_Sent, Transcript_URL,
//   Recording_URL, AI_Follow_Up_Scheduled
//
// Lead_Status is NEVER touched by this route.
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/retell-callback', async (req, res) => {
  // Retell HMAC verification (if secret configured)
  if (RETELL_WEBHOOK_SECRET) {
    const sig     = req.headers['x-retell-signature'] || '';
    const payload = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', RETELL_WEBHOOK_SECRET).update(payload).digest('hex');
    if (sig !== expected) {
      console.error('[retell-callback] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const { event, call } = req.body || {};
  console.log('[retell-callback] event=' + event);
  if (event !== 'call_ended') return res.json({ ignored: true, event });

  const vars            = (call && call.retell_llm_dynamic_variables) || {};
  const leadId          = vars.lead_id;
  const leadName        = vars.lead_name  || 'Lead';
  const leadEmail       = vars.lead_email || '';
  const leadPhone       = vars.lead_phone || '';   // now included in dynamic vars
  const transcript      = (call && call.transcript)      || '';
  const recordingUrl    = (call && call.recording_url)   || '';
  const transcriptUrl   = (call && call.public_log_url)  || '';
  const disconnectReason = (call && call.disconnection_reason) || 'unknown';

  if (!leadId) {
    console.warn('[retell-callback] Missing lead_id');
    return res.status(400).json({ error: 'lead_id missing' });
  }

  const callStatus      = getCallStatus(disconnectReason, transcript);
  const analysis        = analyzeTranscript(transcript, callStatus);
  const outcome         = analysis.outcome;
  const meetingInterested = analysis.meetingInterested;
  const bookingLinkSent = meetingInterested === 'Yes' ? 'Yes' : 'No';

  console.log('[retell-callback] leadId=' + leadId + ' callStatus=' + callStatus + ' outcome=' + outcome + ' disconnect=' + disconnectReason);

  // Release queue lock immediately — next call can start its 2-min gap timer
  callEnded(false);

  // Respond to Retell immediately
  res.json({ success: true, leadId, callStatus, outcome, meetingInterested, bookingLinkSent });

  // Async CRM work (non-blocking, does NOT block the queue)
  (async () => {
    let currentCallCount = 1;
    let freshPhone = leadPhone;  // use phone from dynamic vars as primary source
    let freshCompany = '';
    try {
      const fresh = await getZohoLead(leadId);
      currentCallCount = parseInt((fresh && fresh.AI_Call_Count) || '1', 10);
      if (!freshPhone) freshPhone = (fresh && fresh.Phone) || '';
      freshCompany = (fresh && fresh.Company) || '';
    } catch (e) {
      console.warn('[retell-callback] Could not fetch lead:', e.message);
    }

    const callDate = nowString();

    // ── Update ONLY AI Call Tracking fields — Lead_Status is NOT updated ────
    await safeUpdateZohoLead(leadId, {
      AI_Last_Call_Status : callStatus,
      AI_Last_Call_Date   : callDate,
      Call_Outcome        : outcome,
      Meeting_Interested  : meetingInterested,
      Booking_Link_Sent   : bookingLinkSent,
      Call_Summary        : transcript
        ? (transcript.length > 2000 ? transcript.slice(0, 2000) + ' [truncated]' : transcript)
        : '',
      Recording_URL       : recordingUrl,
      Transcript_URL      : transcriptUrl,
      AI_Call_Count       : currentCallCount
    });
    console.log('[retell-callback] AI Call Tracking updated for lead ' + leadId);

    // Add call-summary note
    try {
      await addZohoNote(leadId, leadName, callStatus, outcome, transcript, callDate);
      console.log('[retell-callback] Note added for lead ' + leadId);
    } catch (e) {
      console.error('[retell-callback] Note failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    }

    // ── Schedule follow-up if needed ─────────────────────────────────────────
    const needsFollowUp = FOLLOWUP_ELIGIBLE_STATUSES.has(callStatus);

    if (needsFollowUp && currentCallCount < MAX_CALLS_PER_LEAD) {
      const followLead = {
        id      : leadId,
        name    : leadName,
        phone   : freshPhone,
        email   : leadEmail,
        company : freshCompany
      };
      if (followLead.phone) {
        const delayMs    = getDelayUntilNext330AMIST();
        const fireAtStr  = new Date(Date.now() + delayMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        console.log('[retell-callback] Follow-up for lead ' + leadId + ' at ' + fireAtStr + ' UTC');
        try {
          await safeUpdateZohoLead(leadId, {
            AI_Last_Call_Status   : 'Follow-Up Scheduled',
            AI_Follow_Up_Scheduled: fireAtStr
          });
        } catch (e) {
          console.error('[retell-callback] Could not mark Follow-Up Scheduled:', e.message);
        }
        scheduleFollowUpCall(followLead, delayMs);
      } else {
        console.warn('[retell-callback] No phone for lead ' + leadId + ' — follow-up skipped');
      }
    } else if (needsFollowUp && currentCallCount >= MAX_CALLS_PER_LEAD) {
      console.log('[retell-callback] Max calls reached for lead ' + leadId);
      try { await safeUpdateZohoLead(leadId, { AI_Last_Call_Status: 'Max Calls Reached' }); } catch (_) {}
    }

    // ── Send onboarding email if interested ───────────────────────────────────
    if (meetingInterested === 'Yes' && leadEmail) {
      try {
        await withRetry(() => sendBookingEmail(leadName, leadEmail));
        console.log('[retell-callback] Onboarding email sent to ' + leadEmail);
      } catch (e) {
        console.error('[retell-callback] Email failed:', e.message);
      }
    }
  })();
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 3: Health check
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/health', (_req, res) => {
  res.json({
    status    : 'ok',
    service   : 'zoho-retell-middleware',
    timestamp : new Date().toISOString(),
    queue     : {
      active      : isCallActive,
      activeCallId: activeCallId,
      pending     : callQueue.length,
      lastCallEnded: lastCallEndedAt ? new Date(lastCallEndedAt).toISOString() : null,
      nextCallIn  : (isCallActive || callQueue.length === 0) ? null
        : Math.max(0, Math.round((POST_CALL_GAP_MS - (Date.now() - lastCallEndedAt)) / 1000)) + 's'
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 4: Admin — queue management
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/admin/queue', (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  res.json({
    isCallActive,
    activeCallId,
    queueLength  : callQueue.length,
    pending      : callQueue.map(i => ({ id: i.lead.id, name: i.lead.name, source: i.source })),
    lastCallEnded: lastCallEndedAt ? new Date(lastCallEndedAt).toISOString() : null
  });
});

app.post('/admin/queue/clear', (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const cleared = callQueue.length;
  callQueue.length = 0;
  console.log('[admin] Queue cleared (' + cleared + ' items removed)');
  res.json({ success: true, cleared });
});

app.post('/admin/queue/release-lock', (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  console.warn('[admin] Manual lock release requested');
  callEnded(true);
  res.json({ success: true, message: 'Lock released' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 5: Admin — manual trigger of daily requeue (for testing)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/admin/run-requeue', async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  res.json({ success: true, message: 'Requeue started' });
  runDailyRequeue().catch(e => console.error('[admin/run-requeue] Error:', e.message));
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 6: Admin — one-time backfill of AI_Call_Count
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/admin/backfill-call-count', async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const CALLED_STATUSES = new Set([
    'No Answer', 'Voicemail', 'Callback Requested', 'Call Initiated',
    'Follow-Up Scheduled', 'Completed', 'Failed', 'Busy', 'Call Failed'
  ]);
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  let page = 1, updated = 0, skipped = 0, errors = 0, total = 0;
  res.json({ success: true, message: 'Backfill started — check logs' });
  try {
    while (true) {
      const token = await getZohoAccessToken();
      const r = await axios.get(baseUrl + '/crm/v3/Leads', {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        params : { fields: 'id,First_Name,Last_Name,AI_Call_Count,AI_Last_Call_Status,Lead_Status', per_page: 200, page }
      });
      const leads = (r.data && r.data.data) || [];
      total += leads.length;
      if (!leads.length) break;
      for (const lead of leads) {
        const status     = (lead.AI_Last_Call_Status || '').trim();
        const leadStatus = (lead.Lead_Status         || '').trim();
        const count      = lead.AI_Call_Count;
        if (isDoNotCallStatus(leadStatus))                           { skipped++; continue; }
        if (!status || !CALLED_STATUSES.has(status))                 { skipped++; continue; }
        if (count !== null && count !== undefined && parseInt(count) > 0) { skipped++; continue; }
        try {
          await updateZohoLead(lead.id, { AI_Call_Count: 1 });
          console.log('[backfill] AI_Call_Count=1 for ' + (lead.First_Name || '') + ' ' + (lead.Last_Name || ''));
          updated++;
          await new Promise(r => setTimeout(r, 200));
        } catch (e) {
          console.error('[backfill] Failed for ' + lead.id + ':', e.message);
          errors++;
        }
      }
      if (!(r.data && r.data.info && r.data.info.more_records)) break;
      page++;
    }
  } catch (e) { console.error('[backfill] Fatal:', e.message); }
  console.log('[backfill] Done. total=' + total + ' updated=' + updated + ' skipped=' + skipped + ' errors=' + errors);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Daily 3:30 AM IST Auto-Requeue
// Enqueues leads that need follow-up. Does NOT mark CRM before enqueuing
// (to avoid the "stuck in Follow-Up Scheduled" loop bug).
// ═══════════════════════════════════════════════════════════════════════════════
async function runDailyRequeue() {
  console.log('[daily-requeue] Starting run...');
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  let page = 1, queued = 0, skipped = 0, errors = 0, totalFetched = 0;
  try {
    while (true) {
      const token = await getZohoAccessToken();
      const r = await axios.get(baseUrl + '/crm/v3/Leads', {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        params : {
          fields  : 'id,First_Name,Last_Name,Phone,Email,Company,AI_Call_Count,AI_Last_Call_Status,Lead_Status',
          per_page: 200,
          page
        }
      });
      const leads = (r.data && r.data.data) || [];
      totalFetched += leads.length;
      if (!leads.length) break;

      for (const lead of leads) {
        const count   = parseInt(lead.AI_Call_Count || '0', 10);
        const status  = (lead.AI_Last_Call_Status || '').trim();
        const phone   = lead.Phone || '';
        const lStatus = (lead.Lead_Status          || '').trim();

        if (isDoNotCallStatus(lStatus))                          { skipped++; continue; }
        if (count >= MAX_CALLS_PER_LEAD)                         { skipped++; continue; }
        if (TERMINAL_STATUSES.has(status))                       { skipped++; continue; }
        if (!phone)                                              { skipped++; continue; }
        // Skip leads that have never been called and have no AI status
        if (count === 0 && !status)                              { skipped++; continue; }
        // Only requeue if status indicates follow-up is needed
        if (!FOLLOWUP_ELIGIBLE_STATUSES.has(status) && status !== '') { skipped++; continue; }

        const leadObj = {
          id     : lead.id,
          name   : ((lead.First_Name || '') + ' ' + (lead.Last_Name || '')).trim() || 'Valued Lead',
          phone,
          email  : lead.Email   || '',
          company: lead.Company || ''
        };

        // Enqueue first; only mark CRM if enqueue succeeds (not a duplicate)
        const wasAlready = callQueue.some(item => item.lead.id === lead.id);
        if (wasAlready) { skipped++; continue; }

        try {
          enqueueCall(leadObj, 'daily-requeue', 'normal');
          // Mark CRM after successful enqueue
          await safeUpdateZohoLead(lead.id, {
            AI_Last_Call_Status   : 'Follow-Up Scheduled',
            AI_Follow_Up_Scheduled: nowString()
          });
          console.log('[daily-requeue] Enqueued lead ' + lead.id + ' (' + leadObj.name + ') count=' + count);
          queued++;
        } catch (err) {
          console.error('[daily-requeue] Failed for lead ' + lead.id + ':', err.message);
          errors++;
        }
      }

      if (!(r.data && r.data.info && r.data.info.more_records)) break;
      if (totalFetched >= DAILY_REQUEUE_MAX) {
        console.log('[daily-requeue] Hit ' + DAILY_REQUEUE_MAX + ' record limit');
        break;
      }
      page++;
    }
  } catch (err) {
    console.error('[daily-requeue] Fatal:', err.message);
  }
  console.log('[daily-requeue] Done. fetched=' + totalFetched + ' queued=' + queued + ' skipped=' + skipped + ' errors=' + errors);
}

function scheduleDailyRequeue() {
  const delayMs = getDelayUntilNext330AMIST();
  console.log('[daily-requeue] Next run in ' + Math.round(delayMs / 60000) + ' min');
  setTimeout(async () => {
    await runDailyRequeue();
    scheduleDailyRequeue();
  }, delayMs);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════════════════════════
const port = PORT || 3000;
app.listen(port, () => {
  console.log('[server] zoho-retell-middleware on port ' + port);
  console.log('[server] Zoho webhook  : POST /webhook/zoho-lead');
  console.log('[server] Retell callback: POST /webhook/retell-callback');
  console.log('[server] Health        : GET  /health');
  console.log('[server] Queue status  : GET  /admin/queue?secret=...');
  scheduleDailyRequeue();
});

// ═══════════════════════════════════════════════════════════════════════════════
// OAuth Callback (one-time token exchange)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');
  try {
    const r = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
      params: {
        code,
        client_id    : ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        redirect_uri : 'https://zoho-retell-middleware-production.up.railway.app/oauth/callback',
        grant_type   : 'authorization_code'
      }
    });
    console.log('[oauth-callback] Token response:', JSON.stringify(r.data));
    const rt = r.data.refresh_token;
    return rt
      ? res.send('<h2>SUCCESS</h2><p>Refresh token:</p><pre>' + rt + '</pre><p>Set as ZOHO_REFRESH_TOKEN in Railway.</p>')
      : res.send('<h2>Error</h2><pre>' + JSON.stringify(r.data) + '</pre>');
  } catch (err) {
    const d = err.response ? err.response.data : err.message;
    console.error('[oauth-callback] Error:', d);
    return res.status(500).send('<h2>Error</h2><pre>' + JSON.stringify(d) + '</pre>');
  }
});

module.exports = app;
