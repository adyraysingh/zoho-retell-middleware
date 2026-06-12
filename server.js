'use strict';
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// --- Environment Variables ---
const {
  RETELL_API_KEY,
  RETELL_AGENT_ID,
  RETELL_FROM_NUMBER,
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_API_DOMAIN,
  WEBHOOK_SECRET,
  SMTP_USER,
  SMTP_PASS,
  PORT
} = process.env;

// --- Zoho OAuth Token Cache ---
let cachedToken = null;
let tokenExpiry = 0;

async function getZohoAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await axios.post(
    'https://accounts.zoho.in/oauth/v2/token',
    null,
    {
      params: {
        refresh_token: ZOHO_REFRESH_TOKEN,
        client_id:     ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        grant_type:    'refresh_token'
      }
    }
  );

  if (!res.data.access_token) {
    throw new Error('Failed to get Zoho access token: ' + JSON.stringify(res.data));
  }

  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

// --- Retell API: Place Outbound Call ---
async function placeRetellCall(lead) {
  const payload = {
    agent_id:    RETELL_AGENT_ID,
    from_number: RETELL_FROM_NUMBER,
    to_number:   lead.phone,
    retell_llm_dynamic_variables: {
      lead_id:      lead.id,
      lead_name:    lead.name,
      lead_email:   lead.email,
      company:      lead.company || 'your company',
      booking_link: 'https://makeyourlabel.zohobookings.in/#/makeyourlabel'
    }
  };

  const res = await axios.post(
    'https://api.retellai.com/v2/create-phone-call',
    payload,
    { headers: { Authorization: `Bearer ${RETELL_API_KEY}` } }
  );

  return res.data;
}

// --- Zoho CRM: Update Lead Fields ---
async function updateZohoLead(leadId, fields) {
  const token   = await getZohoAccessToken();
  const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';

  await axios.put(
    `${baseUrl}/crm/v3/Leads/${leadId}`,
    { data: [fields] },
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
}

// --- Send Booking Email via SMTP (Zoho Mail) ---
async function sendBookingEmail(leadName, leadEmail) {
  if (!SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP_USER or SMTP_PASS not configured');
  }

  const transporter = nodemailer.createTransport({
    host:   'smtp.zoho.in',
    port:   465,
    secure: true,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  await transporter.sendMail({
    from:    `"MakeYourLabel" <${SMTP_USER}>`,
    to:      `"${leadName}" <${leadEmail}>`,
    subject: 'Your Free Consultation Booking - MakeYourLabel',
    text: `Hi ${leadName},

Thank you for your interest in launching your own clothing brand with MakeYourLabel!

We would love to connect with you. Please book your free consultation using the link below:

https://makeyourlabel.zohobookings.in/#/makeyourlabel

Our team will walk you through everything - from design to production.

Looking forward to speaking with you!

Warm regards,
Team MakeYourLabel
www.makeyourlabel.com`,
    html: `<p>Hi ${leadName},</p><p>Thank you for your interest in launching your own clothing brand with <strong>MakeYourLabel</strong>!</p><p>Please book your free consultation:</p><p><a href="https://makeyourlabel.zohobookings.in/#/makeyourlabel" style="background:#0066cc;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Book Free Consultation</a></p><p>Our team will walk you through everything - from design to production.</p><br><p>Warm regards,<br><strong>Team MakeYourLabel</strong><br>www.makeyourlabel.com</p>`
  });
}

// --- Analyze Transcript for Outcome ---
function analyzeTranscript(transcript) {
  transcript = transcript || '';
  const lower = transcript.toLowerCase();

  if (!transcript || transcript.trim().length < 10) {
    return { outcome: 'No Answer', meetingInterested: 'No' };
  }

  const positiveSignals = [
    'yes', 'interested', 'sure', 'absolutely', 'of course',
    'would like', 'want to', 'sounds good', 'great', 'perfect',
    'tell me more', 'how does it work', 'book', 'consultation'
  ];

  const negativeSignals = [
    'not interested', 'no thank', 'dont want', "don't want",
    'please remove', 'do not call', 'busy', 'wrong number'
  ];

  const isPositive = positiveSignals.some(function(s) { return lower.includes(s); });
  const isNegative = negativeSignals.some(function(s) { return lower.includes(s); });

  if (isNegative) return { outcome: 'Not Interested', meetingInterested: 'No' };
  if (isPositive) return { outcome: 'Interested',     meetingInterested: 'Yes' };

  return { outcome: 'Callback Requested', meetingInterested: 'No' };
}

// --- Retry Utility ---
async function withRetry(fn, retries, delayMs) {
  retries = retries || 3;
  delayMs = delayMs || 2000;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn('Attempt ' + attempt + ' failed, retrying in ' + delayMs + 'ms...');
      await new Promise(function(r) { setTimeout(r, delayMs); });
    }
  }
}

// ROUTE 1: Zoho CRM Webhook -> Receive new lead -> Trigger Retell AI call
app.post('/webhook/zoho-lead', async (req, res) => {
  console.log('[zoho-lead] Incoming payload:', JSON.stringify(req.body, null, 2));

  const { webhook_secret, id, First_Name, Last_Name, Phone, Email, Company } = req.body;

  if (!WEBHOOK_SECRET || webhook_secret !== WEBHOOK_SECRET) {
    console.error('[zoho-lead] Unauthorized request');
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (!Phone) {
    console.warn('[zoho-lead] No phone number for lead', id);
    return res.status(400).json({ error: 'Phone number required' });
  }

  const lead = {
    id,
    name:    (First_Name || '') + ' ' + (Last_Name || ''),
    phone:   Phone,
    email:   Email,
    company: Company
  };
  lead.name = lead.name.trim() || 'Valued Lead';

  try {
    const callData = await withRetry(function() { return placeRetellCall(lead); });
    console.log('[zoho-lead] Call placed. call_id=' + callData.call_id);

    try {
      await updateZohoLead(id, {
        AI_Last_Call_Status: 'Call Initiated',
        AI_Last_Call_Date:   new Date().toISOString()
      });
    } catch (crmErr) {
      console.warn('[zoho-lead] CRM status update failed (non-fatal):', crmErr.message);
    }

    return res.json({ success: true, call_id: callData.call_id });

  } catch (err) {
    console.error('[zoho-lead] Failed to place call:', err.response ? err.response.data : err.message);

    try {
      await updateZohoLead(id, { AI_Last_Call_Status: 'Call Failed' });
    } catch (updateErr) {
      console.error('[zoho-lead] Failed to update CRM status:', updateErr.message);
    }

    return res.status(500).json({ error: 'Failed to place call', details: err.message });
  }
});

// ROUTE 2: Retell AI Post-Call Webhook -> Update CRM + Send Email
app.post('/webhook/retell-callback', async (req, res) => {
  console.log('[retell-callback] Incoming event:', req.body && req.body.event);

  const { event, call } = req.body;

  if (event !== 'call_ended') {
    return res.json({ ignored: true, event });
  }

  const vars           = (call && call.retell_llm_dynamic_variables) || {};
  const leadId         = vars.lead_id;
  const leadName       = vars.lead_name  || 'Lead';
  const leadEmail      = vars.lead_email || '';
  const transcript     = (call && call.transcript)     || '';
  const recordingUrl   = (call && call.recording_url)  || '';
  const transcriptUrl  = (call && call.public_log_url) || '';
  const disconnectReason = (call && call.disconnection_reason) || 'unknown';

  if (!leadId) {
    console.warn('[retell-callback] No lead_id in dynamic variables');
    return res.status(400).json({ error: 'lead_id missing in call variables' });
  }

  let callStatus = 'Completed';
  if (disconnectReason === 'machine_detected') callStatus = 'Voicemail';
  else if (disconnectReason === 'dial_no_answer') callStatus = 'No Answer';
  else if (disconnectReason === 'dial_failed')    callStatus = 'Failed';

  const analysis = analyzeTranscript(transcript);
  const outcome = analysis.outcome;
  const meetingInterested = analysis.meetingInterested;
  const bookingLinkSent = meetingInterested === 'Yes' ? 'Yes' : 'No';

  console.log('[retell-callback] leadId=' + leadId + ' status=' + callStatus + ' outcome=' + outcome + ' interested=' + meetingInterested);

  try {
    await withRetry(function() {
      return updateZohoLead(leadId, {
        AI_Last_Call_Status: callStatus,
        AI_Last_Call_Date:   new Date().toISOString(),
        Call_Outcome:        outcome,
        Meeting_Interested:  meetingInterested,
        Booking_Link_Sent:   bookingLinkSent,
        Call_Summary:        transcript.slice(0, 2000),
        Recording_URL:       recordingUrl,
        Transcript_URL:      transcriptUrl
      });
    });
    console.log('[retell-callback] CRM updated successfully');
  } catch (err) {
    console.error('[retell-callback] CRM update failed:', err.response ? err.response.data : err.message);
  }

  if (meetingInterested === 'Yes' && leadEmail) {
    try {
      await withRetry(function() { return sendBookingEmail(leadName, leadEmail); });
      console.log('[retell-callback] Booking email sent to ' + leadEmail);
    } catch (err) {
      console.error('[retell-callback] Email send failed:', err.message);
    }
  }

  return res.json({ success: true, leadId, callStatus, outcome, meetingInterested, bookingLinkSent });
});

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    service:   'zoho-retell-middleware',
    timestamp: new Date().toISOString()
  });
});

// Start Server
const port = PORT || 3000;
app.listen(port, () => {
  console.log('[server] zoho-retell-middleware running on port ' + port);
  console.log('[server] Retell webhook: POST /webhook/retell-callback');
  console.log('[server] Zoho webhook:   POST /webhook/zoho-lead');
  console.log('[server] Health check:   GET  /health');
});

module.exports = app;
