'use strict';
require('dotenv').config();

const express = require('express');
const axios = require('axios');

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
  PORT
} = process.env;

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_CALLS_PER_LEAD    = 3;
const CALL_STAGGER_MS       = 5000;          // 5 s between batched follow-ups
const DAILY_REQUEUE_MAX     = 2000;          // Zoho hard cap per run

// Statuses that warrant a follow-up call
const FOLLOWUP_ELIGIBLE_STATUSES = new Set([
  'No Answer', 'Voicemail', 'Callback Requested',
  'Follow-Up Scheduled', 'Call Initiated', 'Failed', 'Call Failed'
]);

// Statuses where no further outreach should happen
const TERMINAL_STATUSES = new Set([
  'Interested', 'Not Interested', 'Max Calls Reached'
]);

// ─── Zoho OAuth Token Cache ───────────────────────────────────────────────────
let cachedToken  = null;
let tokenExpiry  = 0;

async function getZohoAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await axios.post(
    'https://accounts.zoho.in/oauth/v2/token',
    null,
    { params: { refresh_token: ZOHO_REFRESH_TOKEN, client_id: ZOHO_CLIENT_ID,
                client_secret: ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' } }
  );
  if (!res.data.access_token) {
    throw new Error('Zoho token refresh failed: ' + JSON.stringify(res.data));
  }
  cachedToken   = res.data.access_token;
  tokenExpiry   = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── Retry Utility ────────────────────────────────────────────────────────────
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
  if (result && result.status === 'error') {
    throw new Error('Zoho field error: ' + JSON.stringify(result));
  }
  if (result && result.details) {
    console.warn('[zoho-update] Field-level details:', JSON.stringify(result.details));
  }
  return result;
}
// ─── Zoho CRM: Safe update (picklists written individually) ──────────────────
// Zoho rejects batches that mix free-text and picklist fields, so we split them.
const PICKLIST_FIELDS = new Set([
  'Lead_Status', 'AI_Last_Call_Status', 'Call_Outcome', 'Meeting_Interested', 'Booking_Link_Sent'
]);

async function safeUpdateZohoLead(leadId, fields) {
  const freeFields     = {};
  const picklistFields = {};

  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;   // skip nulls
    if (PICKLIST_FIELDS.has(k)) picklistFields[k] = v;
    else freeFields[k] = v;
  }

  // 1. Write all free-text fields in one request
  if (Object.keys(freeFields).length > 0) {
    try {
      await updateZohoLead(leadId, freeFields);
      console.log('[zoho-update] Free fields written:', Object.keys(freeFields).join(', '));
    } catch (err) {
      console.error('[zoho-update] Free fields write FAILED:', err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }

  // 2. Write each picklist field individually (Zoho requirement)
  for (const [k, v] of Object.entries(picklistFields)) {
    if (!v) continue;
    try {
      await updateZohoLead(leadId, { [k]: v });
      console.log('[zoho-update] Picklist written: ' + k + '="' + v + '"');
    } catch (err) {
      console.error('[zoho-update] Picklist FAILED: ' + k + '="' + v + '" =>', err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
}

// ─── Zoho CRM: Add call-summary note ─────────────────────────────────────────
async function addZohoNote(leadId, leadName, callStatus, outcome, transcript, callDate) {
  const token   = await getZohoAccessToken();
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
  const title   = 'AI Call Summary - ' + callDate;
  const body    = 'Call Date: ' + callDate +
    '\nLead Name: ' + leadName +
    '\nCall Status: ' + callStatus +
    '\nOutcome: ' + outcome +
    '\n\n--- Transcript ---\n' + (transcript || 'No transcript available');
  await axios.post(
    baseUrl + '/crm/v3/Notes',
    { data: [{ Note_Title: title, Note_Content: body, Parent_Id: leadId, se_module: 'Leads' }] },
    { headers: { Authorization: 'Zoho-oauthtoken ' + token } }
  );
}

// ─── Retell: Place Outbound Call ──────────────────────────────────────────────
async function placeRetellCall(lead) {
  const payload = {
    agent_id   : RETELL_AGENT_ID,
    from_number: RETELL_FROM_NUMBER,
    to_number  : lead.phone,
    retell_llm_dynamic_variables: {
      lead_id     : lead.id,
      lead_name   : lead.name,
      lead_email  : lead.email  || '',
      company     : lead.company || 'your company',
      booking_link: 'https://start.makeyourlabel.com/'
    }
  };
  const res = await axios.post(
    'https://api.retellai.com/v2/create-phone-call',
    payload,
    { headers: { Authorization: 'Bearer ' + RETELL_API_KEY } }
  );
  return res.data;
}

// ─── Email: Send Onboarding Link ──────────────────────────────────────────────
async function sendBookingEmail(leadName, leadEmail) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const firstName = (leadName || '').split(' ')[0] || leadName;
  await axios.post('https://api.resend.com/emails', {
    from   : 'MAYA | MakeYourLabel <aditya.raysingh@makeyourlabel.com>',
    to     : [leadEmail],
    subject: 'Get Started with MakeYourLabel',
    text   : 'Hi ' + firstName + ',\n\nThank you for your interest in MakeYourLabel.\n\nPlease complete your onboarding here:\nhttps://start.makeyourlabel.com/\n\nRegards,\nMAYA\nMakeYourLabel',
    html   : '<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.7;max-width:600px;"><p>Hi ' + firstName + ',</p><p>Thank you for your interest in MakeYourLabel.</p><p><a href=\"https://start.makeyourlabel.com/\" style=\"background:#000;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-weight:bold;\">Start Onboarding</a></p><p>If you have any questions, simply reply to this email.</p><br><p>Regards,<br><strong>MAYA</strong><br>MakeYourLabel</p></div>'
  }, { headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' } });
}
// ─── Transcript Analysis ──────────────────────────────────────────────────────
// Returns { outcome, meetingInterested } based on keyword signals.
// callStatus is passed in to disambiguate short transcripts.
function analyzeTranscript(transcript, callStatus) {
  transcript = transcript || '';
  const lower = transcript.toLowerCase().trim();

  // If call was never answered or transcript is too short, outcome matches callStatus
  if (!lower || lower.length < 10) {
    if (callStatus === 'Voicemail') return { outcome: 'Voicemail Left',   meetingInterested: 'No' };
    return                                 { outcome: 'No Answer',         meetingInterested: 'No' };
  }

  const NEGATIVE = ['not interested', 'no thank', "don't want", 'dont want',
                    'please remove', 'do not call', 'wrong number', 'stop calling'];
  const CALLBACK = ['call me tomorrow', 'call back tomorrow', 'call later',
                    'try again tomorrow', 'call me later', 'call again', 'busy right now'];
  const POSITIVE = ['yes', 'interested', 'sure', 'absolutely', 'of course',
                    'would like', 'want to', 'sounds good', 'great', 'perfect',
                    'tell me more', 'how does it work', 'book', 'consultation', 'sign up'];

  const isNeg = NEGATIVE.some(s => lower.includes(s));
  const isCB  = CALLBACK.some(s => lower.includes(s));
  const isPos = POSITIVE.some(s => lower.includes(s));

  if (isNeg) return { outcome: 'Not Interested',     meetingInterested: 'No'  };
  if (isCB)  return { outcome: 'Callback Requested', meetingInterested: 'No'  };
  if (isPos) return { outcome: 'Interested',         meetingInterested: 'Yes' };

  // Answered but no clear signal — treat as a completed call worth following up
  return { outcome: 'Callback Requested', meetingInterested: 'No' };
}

// ─── Map Retell disconnect reason -> callStatus ───────────────────────────────
function getCallStatus(disconnectReason, transcript) {
  const dr = (disconnectReason || '').toLowerCase();
  if (dr === 'machine_detected' || dr === 'voicemail_reached') return 'Voicemail';
  if (dr === 'dial_no_answer'   || dr === 'no_answer')         return 'No Answer';
  if (dr === 'dial_failed'      || dr === 'error')             return 'Failed';
  // user_hangup or unknown — real answer only if transcript has substance
  if ((transcript || '').trim().length >= 50)                  return 'Completed';
  return 'No Answer';
}

// ─── Map callStatus -> Zoho Lead_Status ──────────────────────────────────────
function getZohoLeadStatus(callStatus) {
  return callStatus === 'Completed' ? 'Contacted' : 'Attempted to Contact';
}

// ─── IST time helpers ─────────────────────────────────────────────────────────
const IST_OFFSET_MS    = 5.5 * 3600 * 1000;
const THREE_THIRTY_MS  = 3.5 * 3600 * 1000;

function getDelayUntilNext330AMIST() {
  const nowUTC      = Date.now();
  const nowIST      = new Date(nowUTC + IST_OFFSET_MS);
  const midnightIST = Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()) - IST_OFFSET_MS;
  let target        = midnightIST + THREE_THIRTY_MS;
  if (nowUTC >= target) target += 24 * 3600 * 1000;
  const delay = target - nowUTC;
  console.log('[scheduler] Next 3:30 AM IST: ' + new Date(target).toISOString() + ' (in ' + Math.round(delay / 60000) + ' min)');
  return delay;
}

// ─── Schedule a single follow-up call ────────────────────────────────────────
function scheduleFollowUpCall(lead, delayMs) {
  console.log('[followup] Scheduling lead ' + lead.id + ' (' + lead.name + ') in ' + Math.round(delayMs / 60000) + ' min');
  setTimeout(async function () {
    console.log('[followup] Firing for lead ' + lead.id);
    try {
      const fresh = await getZohoLead(lead.id);
      if (!fresh) { console.warn('[followup] Lead ' + lead.id + ' not found, skipping'); return; }

      const count   = parseInt(fresh.AI_Call_Count || '0', 10);
      const status  = (fresh.AI_Last_Call_Status || '').trim();
      const lStatus = (fresh.Lead_Status || '').trim();

      if (lStatus === 'Contacted')                      { console.log('[followup] Lead ' + lead.id + ' already Contacted, skipping'); return; }
      if (count >= MAX_CALLS_PER_LEAD)                  { await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Max Calls Reached' }); return; }
      if (!FOLLOWUP_ELIGIBLE_STATUSES.has(status))      { console.log('[followup] Lead ' + lead.id + ' status "' + status + '" not eligible, skipping'); return; }

      const callData = await withRetry(() => placeRetellCall(lead));
      console.log('[followup] Call placed for lead ' + lead.id + ', call_id=' + callData.call_id);

      await safeUpdateZohoLead(lead.id, {
        AI_Last_Call_Status: 'Call Initiated',
        AI_Last_Call_Date  : new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
        AI_Call_Count      : count + 1,
        Lead_Status        : 'Attempted to Contact'
      });
    } catch (err) {
      console.error('[followup] Failed for lead ' + lead.id + ':', err.response ? err.response.data : err.message);
      try { await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Call Failed' }); } catch (_) {}
    }
  }, delayMs);
}
// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 1: Zoho CRM Webhook → new lead → trigger Retell call
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/zoho-lead', async (req, res) => {
  console.log('[zoho-lead] Incoming:', JSON.stringify(req.body, null, 2));

  const { webhook_secret, id, First_Name, Last_Name, Phone, Email, Company } = req.body;

  // Auth check
  if (!WEBHOOK_SECRET || webhook_secret !== WEBHOOK_SECRET) {
    console.error('[zoho-lead] Unauthorized');
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (!id)    { return res.status(400).json({ error: 'Lead id required' }); }
  if (!Phone) { console.warn('[zoho-lead] No phone for lead', id); return res.status(400).json({ error: 'Phone required' }); }

  // ── Gate checks ──
  try {
    const existing = await getZohoLead(id);
    const ls       = (existing && existing.Lead_Status || '').trim();
    const aiStatus = (existing && existing.AI_Last_Call_Status || '').trim();
    const count    = parseInt((existing && existing.AI_Call_Count) || '0', 10);

    if (ls === 'Contacted')                     { return res.json({ success: false, skipped: true, reason: 'Already Contacted' }); }
    if (count >= MAX_CALLS_PER_LEAD)            { return res.json({ success: false, skipped: true, reason: 'Max calls reached', AI_Call_Count: count }); }
    if (TERMINAL_STATUSES.has(aiStatus))        { return res.json({ success: false, skipped: true, reason: 'Terminal AI status: ' + aiStatus }); }
  } catch (fetchErr) {
    console.warn('[zoho-lead] Could not fetch lead (proceeding):', fetchErr.message);
  }

  const lead = {
    id,
    name   : ((First_Name || '') + ' ' + (Last_Name || '')).trim() || 'Valued Lead',
    phone  : Phone,
    email  : Email  || '',
    company: Company || ''
  };

  try {
    // Respond immediately — Zoho expects a quick 200
    res.json({ success: true, message: 'Call queued', leadId: id });

    const callData = await withRetry(() => placeRetellCall(lead));
    console.log('[zoho-lead] Call placed. call_id=' + callData.call_id);

    // Re-fetch to get accurate call count (avoids race conditions)
    let newCount = 1;
    try {
      const fresh = await getZohoLead(id);
      newCount = parseInt((fresh && fresh.AI_Call_Count) || '0', 10) + 1;
    } catch (_) {}

    await safeUpdateZohoLead(id, {
      AI_Last_Call_Status: 'Call Initiated',
      AI_Last_Call_Date  : new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
      AI_Call_Count      : newCount,
      Lead_Status        : 'Attempted to Contact'
    });
  } catch (err) {
    console.error('[zoho-lead] Failed to place call:', err.response ? err.response.data : err.message);
    try { await safeUpdateZohoLead(id, { AI_Last_Call_Status: 'Call Failed' }); } catch (_) {}
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 2: Retell post-call webhook → update CRM + schedule follow-ups + email
// Responds 200 immediately; all CRM work is fire-and-forget to avoid Retell retries.
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/retell-callback', async (req, res) => {
  const { event, call } = req.body || {};
  console.log('[retell-callback] event=' + event);

  if (event !== 'call_ended') return res.json({ ignored: true, event });

  const vars             = (call && call.retell_llm_dynamic_variables) || {};
  const leadId           = vars.lead_id;
  const leadName         = vars.lead_name  || 'Lead';
  const leadEmail        = vars.lead_email || '';
  const transcript       = (call && call.transcript)        || '';
  const recordingUrl     = (call && call.recording_url)     || '';
  const transcriptUrl    = (call && call.public_log_url)    || '';
  const disconnectReason = (call && call.disconnection_reason) || 'unknown';

  if (!leadId) {
    console.warn('[retell-callback] Missing lead_id');
    return res.status(400).json({ error: 'lead_id missing' });
  }

  const callStatus       = getCallStatus(disconnectReason, transcript);
  const analysis         = analyzeTranscript(transcript, callStatus);
  const outcome          = analysis.outcome;
  const meetingInterested = analysis.meetingInterested;
  const bookingLinkSent  = meetingInterested === 'Yes' ? 'Yes' : 'No';
  const zohoLeadStatus   = getZohoLeadStatus(callStatus);

  console.log('[retell-callback] leadId=' + leadId + ' callStatus=' + callStatus + ' outcome=' + outcome + ' disconnect=' + disconnectReason);

  // ── Respond immediately so Retell does not retry ──
  res.json({ success: true, leadId, callStatus, outcome, meetingInterested, bookingLinkSent });

  // ── Async CRM work ────────────────────────────────────────────────────────
  (async () => {
    // Fetch fresh lead data for call count + phone
    let currentCallCount = 1;
    let leadPhone = '', leadCompany = '';
    try {
      const fresh    = await getZohoLead(leadId);
      currentCallCount = parseInt((fresh && fresh.AI_Call_Count) || '1', 10);
      leadPhone      = (fresh && fresh.Phone)   || '';
      leadCompany    = (fresh && fresh.Company) || '';
    } catch (e) {
      console.warn('[retell-callback] Could not fetch lead:', e.message);
    }

    const callDate = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    // Update all CRM fields
    await safeUpdateZohoLead(leadId, {
      AI_Last_Call_Status : callStatus,
      AI_Last_Call_Date   : callDate,
      Call_Outcome        : outcome,
      Meeting_Interested  : meetingInterested,
      Booking_Link_Sent   : bookingLinkSent,
      Call_Summary        : transcript.slice(0, 2000),
      Recording_URL       : recordingUrl,
      Transcript_URL      : transcriptUrl,
      AI_Call_Count       : currentCallCount,
      Lead_Status         : zohoLeadStatus
    });
    console.log('[retell-callback] CRM updated for lead ' + leadId);

    // Add a call note
    try {
      await addZohoNote(leadId, leadName, callStatus, outcome, transcript, callDate);
      console.log('[retell-callback] Note added for lead ' + leadId);
    } catch (e) {
      console.error('[retell-callback] Note failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    }

    // ── Follow-up scheduling ──
    const needsFollowUp = FOLLOWUP_ELIGIBLE_STATUSES.has(callStatus);

    if (needsFollowUp && currentCallCount < MAX_CALLS_PER_LEAD) {
      const lead = { id: leadId, name: leadName, phone: leadPhone, email: leadEmail, company: leadCompany };
      if (lead.phone) {
        const delayMs   = getDelayUntilNext330AMIST();
        const fireAtStr = new Date(Date.now() + delayMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        console.log('[retell-callback] Scheduling follow-up for lead ' + leadId + ' at ' + fireAtStr + ' IST');
        try {
          await safeUpdateZohoLead(leadId, {
            AI_Last_Call_Status  : 'Follow-Up Scheduled',
            AI_Follow_Up_Scheduled: fireAtStr
          });
        } catch (e) { console.error('[retell-callback] Could not mark Follow-Up Scheduled:', e.message); }
        scheduleFollowUpCall(lead, delayMs);
      } else {
        console.warn('[retell-callback] No phone for lead ' + leadId + ', skipping follow-up');
      }
    } else if (needsFollowUp && currentCallCount >= MAX_CALLS_PER_LEAD) {
      console.log('[retell-callback] Max calls reached for lead ' + leadId);
      try { await safeUpdateZohoLead(leadId, { AI_Last_Call_Status: 'Max Calls Reached' }); } catch (_) {}
    }

    // ── Send onboarding email if interested ──
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
  res.json({ status: 'ok', service: 'zoho-retell-middleware', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 4: Admin — manual trigger of daily requeue (for testing)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/admin/run-requeue', async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  res.json({ success: true, message: 'Requeue started' });
  runDailyRequeue().catch(e => console.error('[admin/run-requeue] Error:', e.message));
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE 5: Admin — one-time backfill of AI_Call_Count
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/admin/backfill-call-count', async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  const CALLED_STATUSES = new Set(['No Answer','Voicemail','Callback Requested','Call Initiated',
    'Follow-Up Scheduled','Completed','Failed','Busy','Call Failed']);
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
        const leadStatus = (lead.Lead_Status || '').trim();
        const count      = lead.AI_Call_Count;
        if (leadStatus === 'Contacted')                                         { skipped++; continue; }
        if (!status || !CALLED_STATUSES.has(status))                           { skipped++; continue; }
        if (count !== null && count !== undefined && parseInt(count) > 0)      { skipped++; continue; }
        try {
          await updateZohoLead(lead.id, { AI_Call_Count: 1 });
          console.log('[backfill] AI_Call_Count=1 for ' + (lead.First_Name||'') + ' ' + (lead.Last_Name||''));
          updated++;
          await new Promise(r => setTimeout(r, 200));
        } catch (e) { console.error('[backfill] Failed for ' + lead.id + ':', e.message); errors++; }
      }
      if (!(r.data && r.data.info && r.data.info.more_records)) break;
      page++;
    }
  } catch (e) { console.error('[backfill] Fatal:', e.message); }
  console.log('[backfill] Done. total=' + total + ' updated=' + updated + ' skipped=' + skipped + ' errors=' + errors);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Daily 3:30 AM IST Auto-Requeue
// Fetches all leads not yet at terminal status and schedules follow-up calls.
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
        const count    = parseInt(lead.AI_Call_Count || '0', 10);
        const status   = (lead.AI_Last_Call_Status || '').trim();
        const phone    = lead.Phone || '';
        const lStatus  = (lead.Lead_Status || '').trim();

        // Skip gates
        if (lStatus === 'Contacted')           { skipped++; continue; }
        if (count >= MAX_CALLS_PER_LEAD)        { skipped++; continue; }
        if (TERMINAL_STATUSES.has(status))      { skipped++; continue; }
        if (!phone)                             { skipped++; continue; }
        if (count === 0 && !status)             { skipped++; continue; } // truly fresh — Zoho webhook handles these
        if (!FOLLOWUP_ELIGIBLE_STATUSES.has(status) && status !== '') { skipped++; continue; }

        const leadObj = {
          id     : lead.id,
          name   : ((lead.First_Name || '') + ' ' + (lead.Last_Name || '')).trim() || 'Valued Lead',
          phone,
          email  : lead.Email   || '',
          company: lead.Company || ''
        };

        try {
          const staggerMs = queued * CALL_STAGGER_MS;
          const fireAt    = new Date(Date.now() + staggerMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' UTC';
          await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Follow-Up Scheduled', AI_Follow_Up_Scheduled: fireAt });
          scheduleFollowUpCall(leadObj, staggerMs);
          console.log('[daily-requeue] Queued lead ' + lead.id + ' (' + leadObj.name + ') count=' + count + ' stagger=' + staggerMs / 1000 + 's');
          queued++;
        } catch (err) {
          console.error('[daily-requeue] Failed for lead ' + lead.id + ':', err.message);
          errors++;
        }
      }

      if (!(r.data && r.data.info && r.data.info.more_records)) break;
      if (totalFetched >= DAILY_REQUEUE_MAX) { console.log('[daily-requeue] Hit ' + DAILY_REQUEUE_MAX + ' record limit'); break; }
      page++;
    }
  } catch (err) {
    console.error('[daily-requeue] Fatal:', err.message);
  }
  console.log('[daily-requeue] Done. fetched=' + totalFetched + ' queued=' + queued + ' skipped=' + skipped + ' errors=' + errors);
}

// Self-rescheduling daily trigger
function scheduleDailyRequeue() {
  const delayMs = getDelayUntilNext330AMIST();
  console.log('[daily-requeue] Scheduled in ' + Math.round(delayMs / 60000) + ' min');
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
  console.log('[server] Zoho webhook   : POST /webhook/zoho-lead');
  console.log('[server] Retell callback: POST /webhook/retell-callback');
  console.log('[server] Health         : GET  /health');
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
      params: { code, client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET,
                redirect_uri: 'https://zoho-retell-middleware-production.up.railway.app/oauth/callback',
                grant_type: 'authorization_code' }
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
