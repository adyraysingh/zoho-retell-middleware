'use strict';
require('dotenv').config();

const express = require('express');
const axios = require('axios');
// Email sent via Resend API

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
                  client_id: ZOHO_CLIENT_ID,
                  client_secret: ZOHO_CLIENT_SECRET,
                  grant_type: 'refresh_token'
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

// --- Zoho CRM: Fetch Lead Fields ---
async function getZohoLead(leadId) {
      const token = await getZohoAccessToken();
      const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';

const res = await axios.get(
      `${baseUrl}/crm/v3/Leads/${leadId}`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      );

return (res.data && res.data.data && res.data.data[0]) || null;
}

// --- Retell API: Place Outbound Call ---
async function placeRetellCall(lead) {
      const payload = {
            agent_id: RETELL_AGENT_ID,
            from_number: RETELL_FROM_NUMBER,
            to_number: lead.phone,
            retell_llm_dynamic_variables: {
                  lead_id: lead.id,
                  lead_name: lead.name,
                  lead_email: lead.email,
                  company: lead.company || 'your company',
                  booking_link: 'https://onboarding.makeyourlabel.com/'
            }
      };

const res = await axios.post(
      'https://api.retellai.com/v2/create-phone-call',
      payload,
      { headers: { Authorization: `Bearer ${RETELL_API_KEY}` } }
      );

return res.data;
}

// --- Zoho CRM: Update Lead Fields (with per-field error logging) ---
async function updateZohoLead(leadId, fields) {
      const token = await getZohoAccessToken();
      const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';

const res = await axios.put(
      `${baseUrl}/crm/v3/Leads/${leadId}`,
      { data: [fields] },
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
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

// --- Zoho CRM: Safe update that splits free-text and pick-list fields ---
async function safeUpdateZohoLead(leadId, fields) {
      const safeFields = {};
      const picklistFields = ['AI_Last_Call_Status', 'Call_Outcome', 'Meeting_Interested', 'Booking_Link_Sent'];

for (const [key, value] of Object.entries(fields)) {
      if (!picklistFields.includes(key)) {
            safeFields[key] = value;
      }
}

if (Object.keys(safeFields).length > 0) {
      try {
            await updateZohoLead(leadId, safeFields);
            console.log('[zoho-update] Safe fields written:', Object.keys(safeFields).join(', '));
      } catch (err) {
            console.error('[zoho-update] Safe fields write failed:', err.response ? JSON.stringify(err.response.data) : err.message);
      }
}

for (const key of picklistFields) {
      if (!(key in fields)) continue;
      const value = fields[key];
      if (!value) continue;
      try {
            await updateZohoLead(leadId, { [key]: value });
            console.log(`[zoho-update] Picklist field written: ${key}="${value}"`);
      } catch (err) {
            const errDetail = err.response ? JSON.stringify(err.response.data) : err.message;
            console.error(`[zoho-update] Picklist field FAILED: ${key}="${value}" => ${errDetail}`);
      }
}
}

// --- Send Onboarding Email via Resend API ---
async function sendBookingEmail(leadName, leadEmail) {
      if (!RESEND_API_KEY) {
            throw new Error('RESEND_API_KEY not configured');
      }

  const firstName = leadName.split(' ')[0] || leadName;

        await axios.post('https://api.resend.com/emails', {
                  from: 'MAYA | MakeYourLabel <aditya.raysingh@makeyourlabel.com>',
                  to: [leadEmail],
                  subject: 'Get Started with MakeYourLabel',
                  text: `Hi ${firstName},\n\nThank you for your interest in MakeYourLabel.\n\nTo get started, please complete your onboarding using the link below:\n\nhttps://onboarding.makeyourlabel.com/\n\nOnce submitted, our team will review your requirements and begin planning your brand launch.\n\nIf you have any questions, simply reply to this email.\n\nRegards,\nMAYA\nMakeYourLabel`,
                  html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.7;max-width:600px;"><p>Hi ${firstName},</p><p>Thank you for your interest in MakeYourLabel.</p><p>To get started, please complete your onboarding using the link below:</p><p><a href="https://onboarding.makeyourlabel.com/" style="background:#000;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-weight:bold;">Start Onboarding</a></p><p>Once submitted, our team will review your requirements and begin planning your brand launch.</p><p>If you have any questions, simply reply to this email.</p><br><p>Regards,<br><strong>MAYA</strong><br>MakeYourLabel</p></div>`
        }, {
                  headers: {
                              Authorization: `Bearer ${RESEND_API_KEY}`,
                              'Content-Type': 'application/json'
                  }
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
      if (isPositive) return { outcome: 'Interested', meetingInterested: 'Yes' };

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

         // --- DEDUPLICATION GUARD: Skip if lead was already called ---
         try {
               const existingLead = await getZohoLead(id);
               const existingStatus = existingLead && existingLead.AI_Last_Call_Status;
               if (existingStatus && existingStatus.trim() !== '') {
                     console.log(`[zoho-lead] Lead ${id} already has AI_Last_Call_Status="${existingStatus}". Skipping call to prevent duplicate.`);
                     return res.json({ success: false, skipped: true, reason: 'Lead already called', AI_Last_Call_Status: existingStatus });
               }
         } catch (fetchErr) {
               console.warn('[zoho-lead] Could not fetch lead status from CRM (proceeding with call):', fetchErr.message);
         }

         const lead = {
               id,
               name: ((First_Name || '') + ' ' + (Last_Name || '')).trim() || 'Valued Lead',
               phone: Phone,
               email: Email,
               company: Company
         };

         try {
               const callData = await withRetry(function() { return placeRetellCall(lead); });
               console.log('[zoho-lead] Call placed. call_id=' + callData.call_id);

      try {
            await safeUpdateZohoLead(id, {
                  AI_Last_Call_Status: 'Call Initiated',
                  AI_Last_Call_Date: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
            });
      } catch (crmErr) {
            console.warn('[zoho-lead] CRM status update failed (non-fatal):', crmErr.message);
      }

      return res.json({ success: true, call_id: callData.call_id });

         } catch (err) {
               console.error('[zoho-lead] Failed to place call:', err.response ? err.response.data : err.message);

      try {
            await safeUpdateZohoLead(id, { AI_Last_Call_Status: 'Call Failed' });
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

         const vars = (call && call.retell_llm_dynamic_variables) || {};
      const leadId = vars.lead_id;
      const leadName = vars.lead_name || 'Lead';
      const leadEmail = vars.lead_email || '';
      const transcript = (call && call.transcript) || '';
      const recordingUrl = (call && call.recording_url) || '';
      const transcriptUrl = (call && call.public_log_url) || '';
      const disconnectReason = (call && call.disconnection_reason) || 'unknown';

         if (!leadId) {
               console.warn('[retell-callback] No lead_id in dynamic variables');
               return res.status(400).json({ error: 'lead_id missing in call variables' });
         }

         let callStatus = 'Completed';
      if (disconnectReason === 'machine_detected') callStatus = 'Voicemail';
      else if (disconnectReason === 'dial_no_answer') callStatus = 'No Answer';
      else if (disconnectReason === 'dial_failed') callStatus = 'Failed';

         const analysis = analyzeTranscript(transcript);
      const outcome = analysis.outcome;
      const meetingInterested = analysis.meetingInterested;
      const bookingLinkSent = meetingInterested === 'Yes' ? 'Yes' : 'No';

         console.log('[retell-callback] leadId=' + leadId + ' status=' + callStatus + ' outcome=' + outcome + ' interested=' + meetingInterested);

         await safeUpdateZohoLead(leadId, {
               AI_Last_Call_Status: callStatus,
               AI_Last_Call_Date: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
               Call_Outcome: outcome,
               Meeting_Interested: meetingInterested,
               Booking_Link_Sent: bookingLinkSent,
               Call_Summary: transcript.slice(0, 2000),
               Recording_URL: recordingUrl,
               Transcript_URL: transcriptUrl
         });

         console.log('[retell-callback] CRM update completed (check above for any per-field errors)');

         if (meetingInterested === 'Yes' && leadEmail) {
               try {
                     await withRetry(function() { return sendBookingEmail(leadName, leadEmail); });
                     console.log('[retell-callback] Onboarding email sent to ' + leadEmail);
               } catch (err) {
                     console.error('[retell-callback] Email send failed:', err.message);
               }
         }

         return res.json({ success: true, leadId, callStatus, outcome, meetingInterested, bookingLinkSent });
});

// Health Check
app.get('/health', (req, res) => {
      res.json({
            status: 'ok',
            service: 'zoho-retell-middleware',
            timestamp: new Date().toISOString()
      });
});

// Start Server
const port = PORT || 3000;
app.listen(port, () => {
      console.log('[server] zoho-retell-middleware running on port ' + port);
      console.log('[server] Retell webhook: POST /webhook/retell-callback');
      console.log('[server] Zoho webhook: POST /webhook/zoho-lead');
      console.log('[server] Health check: GET /health');
});

// --- OAuth Callback: Exchange code for refresh token ---
app.get('/oauth/callback', async (req, res) => {
      const code = req.query.code;
      if (!code) {
            return res.status(400).send('No code provided');
      }

        try {
              const tokenRes = await axios.post(
                    'https://accounts.zoho.in/oauth/v2/token',
                    null,
                    {
                          params: {
                                code,
                                client_id: ZOHO_CLIENT_ID,
                                client_secret: ZOHO_CLIENT_SECRET,
                                redirect_uri: 'https://zoho-retell-middleware-production.up.railway.app/oauth/callback',
                                grant_type: 'authorization_code'
                          }
                    }
                    );

      console.log('[oauth-callback] Token response:', JSON.stringify(tokenRes.data));

      const rt = tokenRes.data.refresh_token;
              if (rt) {
                    return res.send('<h2>SUCCESS!</h2><p>Your refresh token:</p><pre>' + rt + '</pre><p>Set this as ZOHO_REFRESH_TOKEN in Railway.</p>');
              } else {
                    return res.send('<h2>Error</h2><pre>' + JSON.stringify(tokenRes.data) + '</pre>');
              }
        } catch (err) {
              const errData = err.response ? err.response.data : err.message;
              console.error('[oauth-callback] Error:', errData);
              return res.status(500).send('<h2>Error</h2><pre>' + JSON.stringify(errData) + '</pre>');
        }
});

module.exports = app;
