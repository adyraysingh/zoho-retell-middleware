'use strict';
require('dotenv').config();

const express = require('express');
const axios = require('axios');

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
        RESEND_API_KEY,
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
                              booking_link: 'https://start.makeyourlabel.com/'
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

// --- Zoho CRM: Safe update splitting free-text and pick-list fields ---
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

// --- Zoho CRM: Add Note to Lead after call ---
async function addZohoNote(leadId, leadName, callStatus, outcome, transcript, callDate) {
        const token = await getZohoAccessToken();
        const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
        const noteTitle = `AI Call Summary - ${callDate}`;
        const noteContent = `Call Date: ${callDate}\nLead Name: ${leadName}\nCall Status: ${callStatus}\nOutcome: ${outcome}\n\n--- Conversation Transcript ---\n${transcript || 'No transcript available'}`;
        await axios.post(
                  `${baseUrl}/crm/v3/Notes`,
              { data: [{ Note_Title: noteTitle, Note_Content: noteContent, Parent_Id: leadId, se_module: 'Leads' }] },
              { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
                );
}

// --- Send Onboarding Email via Resend API ---
async function sendBookingEmail(leadName, leadEmail) {
        if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
        const firstName = leadName.split(' ')[0] || leadName;
        await axios.post('https://api.resend.com/emails', {
                  from: 'MAYA | MakeYourLabel <aditya.raysingh@makeyourlabel.com>',
                  to: [leadEmail],
                  subject: 'Get Started with MakeYourLabel',
                  text: `Hi ${firstName},\n\nThank you for your interest in MakeYourLabel.\n\nTo get started, please complete your onboarding using the link below:\n\nhttps://start.makeyourlabel.com/\n\nOnce submitted, our team will review your requirements and begin planning your brand launch.\n\nIf you have any questions, simply reply to this email.\n\nRegards,\nMAYA\nMakeYourLabel`,
                  html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.7;max-width:600px;"><p>Hi ${firstName},</p><p>Thank you for your interest in MakeYourLabel.</p><p>To get started, please complete your onboarding using the link below:</p><p><a href="https://start.makeyourlabel.com/" style="background:#000;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-weight:bold;">Start Onboarding</a></p><p>Once submitted, our team will review your requirements and begin planning your brand launch.</p><p>If you have any questions, simply reply to this email.</p><br><p>Regards,<br><strong>MAYA</strong><br>MakeYourLabel</p></div>`
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
        const callbackSignals = [
                  'call me tomorrow', 'call back tomorrow', 'call later',
                  'try again tomorrow', 'tomorrow', 'call me later', 'call again'
                ];

  const isNegative = negativeSignals.some(function(s) { return lower.includes(s); });
        const isCallback = callbackSignals.some(function(s) { return lower.includes(s); });
        const isPositive = positiveSignals.some(function(s) { return lower.includes(s); });

  if (isNegative) return { outcome: 'Not Interested', meetingInterested: 'No' };
        if (isCallback) return { outcome: 'Callback Requested', meetingInterested: 'No' };
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

// --- Schedule Follow-Up Calls: today(call1) + tomorrow 9PM IST(call2) + day-after-tomorrow 9PM IST(call3) ---
// Statuses that are eligible for a follow-up call
const FOLLOWUP_ELIGIBLE_STATUSES = ['No Answer', 'Voicemail', 'Callback Requested'];
// Maximum total calls allowed per lead (call 1 today + call 2 tomorrow + call 3 day after tomorrow = 3 max)
const MAX_CALLS_PER_LEAD = 3;

// --- Compute delay (ms) until 9:00 PM IST on the next calendar day ---
function getDelayUntilNext9PMIST() {
          const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30
          const nowUTC = Date.now();
          const nowIST = new Date(nowUTC + IST_OFFSET_MS);
          // Move to next calendar day in IST
          const next9PMIST = new Date(nowIST);
          next9PMIST.setDate(next9PMIST.getDate() + 1);
          next9PMIST.setHours(21, 0, 0, 0); // 9:00 PM IST
          // Convert back to UTC ms
          const next9PMutcMs = next9PMIST.getTime() - IST_OFFSET_MS;
          const delayMs = next9PMutcMs - nowUTC;
          const fireAt = new Date(next9PMutcMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' UTC (9:00 PM IST)';
          console.log('[followup] Next call scheduled at: ' + fireAt + ' (delay=' + Math.round(delayMs / 60000) + ' min)');
          return delayMs;
}

async function scheduleFollowUpCall(lead, delayMs) {
        console.log(`[followup] Scheduling follow-up call for lead ${lead.id} (${lead.name}) in ${delayMs / 3600000} hour(s)`);
        setTimeout(async function() {
                  console.log(`[followup] Firing follow-up call for lead ${lead.id}`);
                  try {
                              // Re-fetch lead to get latest state before calling
                    const freshLead = await getZohoLead(lead.id);
                              if (!freshLead) {
                                            console.warn(`[followup] Lead ${lead.id} not found in CRM, skipping follow-up`);
                                            return;
                              }

                    const callCount = parseInt(freshLead.AI_Call_Count || '0', 10);
                              const currentStatus = (freshLead.AI_Last_Call_Status || '').trim();

                    // Hard stop: never exceed MAX_CALLS_PER_LEAD
                    if (callCount >= MAX_CALLS_PER_LEAD) {
                                  console.log(`[followup] Lead ${lead.id} has already received ${callCount} call(s) (max=${MAX_CALLS_PER_LEAD}). Skipping follow-up.`);
                                  await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Max Calls Reached' });
                                  return;
                    }

                    // Skip if lead is no longer eligible (e.g. became Interested or Not Interested since scheduling)
                    if (!FOLLOWUP_ELIGIBLE_STATUSES.includes(currentStatus)) {
                                  console.log(`[followup] Lead ${lead.id} status is now "${currentStatus}", no longer eligible. Skipping.`);
                                  return;
                    }

                    // Place the follow-up call
                    const callData = await withRetry(function() { return placeRetellCall(lead); });
                              console.log(`[followup] Follow-up call placed for lead ${lead.id}, call_id=${callData.call_id}`);

                    await safeUpdateZohoLead(lead.id, {
                                  AI_Last_Call_Status: 'Call Initiated',
                                  AI_Last_Call_Date: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
                                  AI_Call_Count: String(callCount + 1)
                    });

                  } catch (err) {
                              console.error(`[followup] Follow-up call failed for lead ${lead.id}:`, err.response ? err.response.data : err.message);
                              try {
                                            await safeUpdateZohoLead(lead.id, { AI_Last_Call_Status: 'Call Failed' });
                              } catch (e) {
                                            console.error(`[followup] Could not update CRM after follow-up failure:`, e.message);
                              }
                  }
        }, delayMs);
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
                     const callCount = parseInt((existingLead && existingLead.AI_Call_Count) || '0', 10);

          if (callCount >= MAX_CALLS_PER_LEAD) {
                      console.log(`[zoho-lead] Lead ${id} already received ${callCount} call(s) (max=${MAX_CALLS_PER_LEAD}). Skipping.`);
                      return res.json({ success: false, skipped: true, reason: 'Max calls reached', AI_Call_Count: callCount });
          }

          const existingStatus = existingLead && existingLead.AI_Last_Call_Status;
                     if (existingStatus && existingStatus.trim() !== '' && existingStatus !== 'Max Calls Reached') {
                                 // If status is something terminal, skip
                       const terminalStatuses = ['Interested', 'Not Interested', 'Completed', 'Max Calls Reached'];
                                 if (terminalStatuses.includes(existingStatus.trim())) {
                                               console.log(`[zoho-lead] Lead ${id} has terminal status="${existingStatus}". Skipping.`);
                                               return res.json({ success: false, skipped: true, reason: 'Lead already in terminal status', AI_Last_Call_Status: existingStatus });
                                 }
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

          // Increment call count and set status
          let newCallCount = 1;
                     try {
                                 const freshLead = await getZohoLead(id);
                                 const existing = parseInt((freshLead && freshLead.AI_Call_Count) || '0', 10);
                                 newCallCount = existing + 1;
                     } catch (e) { /* use default */ }

          try {
                      await safeUpdateZohoLead(id, {
                                    AI_Last_Call_Status: 'Call Initiated',
                                    AI_Last_Call_Date: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
                                    AI_Call_Count: String(newCallCount)
                      });
          } catch (crmErr) {
                      console.warn('[zoho-lead] CRM status update failed (non-fatal):', crmErr.message);
          }

          return res.json({ success: true, call_id: callData.call_id, AI_Call_Count: newCallCount });

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

// ROUTE 2: Retell AI Post-Call Webhook -> Update CRM + Schedule follow-up if needed + Send Email
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

           // Determine call status from disconnect reason
           let callStatus = 'Completed';
        if (disconnectReason === 'machine_detected') callStatus = 'Voicemail';
        else if (disconnectReason === 'dial_no_answer') callStatus = 'No Answer';
        else if (disconnectReason === 'dial_failed') callStatus = 'Failed';

           const analysis = analyzeTranscript(transcript);
        const outcome = analysis.outcome;
        const meetingInterested = analysis.meetingInterested;
        const bookingLinkSent = meetingInterested === 'Yes' ? 'Yes' : 'No';

           console.log('[retell-callback] leadId=' + leadId + ' status=' + callStatus + ' outcome=' + outcome + ' interested=' + meetingInterested);

           // --- Fetch current call count before updating ---
           let currentCallCount = 1;
        let leadPhone = '';
        let leadCompany = '';
        try {
                  const freshLead = await getZohoLead(leadId);
                  currentCallCount = parseInt((freshLead && freshLead.AI_Call_Count) || '1', 10);
                  leadPhone = (freshLead && freshLead.Phone) || '';
                  leadCompany = (freshLead && freshLead.Company) || '';
        } catch (e) {
                  console.warn('[retell-callback] Could not fetch lead for call count:', e.message);
        }

           // Update CRM with call result
           await safeUpdateZohoLead(leadId, {
                     AI_Last_Call_Status: callStatus,
                     AI_Last_Call_Date: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
                     Call_Outcome: outcome,
                     Meeting_Interested: meetingInterested,
                     Booking_Link_Sent: bookingLinkSent,
                     Call_Summary: transcript.slice(0, 2000),
                     Recording_URL: recordingUrl,
                     Transcript_URL: transcriptUrl,
                     AI_Call_Count: String(currentCallCount)
           });

           console.log('[retell-callback] CRM update completed');

           // --- Add call summary as Note in Zoho Lead ---
           try {
                     const callDate = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
                     await addZohoNote(leadId, leadName, callStatus, outcome, transcript, callDate);
                     console.log('[retell-callback] Call summary note added to lead ' + leadId);
           } catch (noteErr) {
                     console.error('[retell-callback] Failed to add note:', noteErr.response ? JSON.stringify(noteErr.response.data) : noteErr.message);
           }

           // --- FOLLOW-UP LOGIC ---
           // Schedule a follow-up call tomorrow if:
           //   1. Call status is No Answer, Voicemail, or outcome is Callback Requested
           //   2. Lead has not yet reached the max call limit (MAX_CALLS_PER_LEAD = 3)
           const needsFollowUp = FOLLOWUP_ELIGIBLE_STATUSES.includes(callStatus) || outcome === 'Callback Requested';

           if (needsFollowUp && currentCallCount < MAX_CALLS_PER_LEAD) {
                     const lead = {
                                 id: leadId,
                                 name: leadName,
                                 phone: leadPhone || vars.to_number || '',
                                 email: leadEmail,
                                 company: leadCompany
                     };

          if (lead.phone) {
                              // Schedule next follow-up at 9:00 PM IST next day (call2=tomorrow 9PM, call3=day-after 9PM)
                       const followUpDelayMs = getDelayUntilNext9PMIST(); // fires at 9:00 PM IST next day
                       console.log(`[retell-callback] Lead ${leadId} needs follow-up (status="${callStatus}", outcome="${outcome}", calls so far=${currentCallCount}/${MAX_CALLS_PER_LEAD}). Scheduling for tomorrow.`);
                      await safeUpdateZohoLead(leadId, {
                                    AI_Last_Call_Status: 'Follow-Up Scheduled',
                                    AI_Follow_Up_Scheduled: new Date(Date.now() + followUpDelayMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
                      });
                      scheduleFollowUpCall(lead, followUpDelayMs);
          } else {
                      console.warn(`[retell-callback] Lead ${leadId} needs follow-up but phone number not available. Skipping schedule.`);
          }
           } else if (needsFollowUp && currentCallCount >= MAX_CALLS_PER_LEAD) {
                     console.log(`[retell-callback] Lead ${leadId} needs follow-up but max calls (${MAX_CALLS_PER_LEAD}) reached. Marking as Max Calls Reached.`);
                     await safeUpdateZohoLead(leadId, { AI_Last_Call_Status: 'Max Calls Reached' });
           }

           // --- Send onboarding email if interested ---
           if (meetingInterested === 'Yes' && leadEmail) {
                     try {
                                 await withRetry(function() { return sendBookingEmail(leadName, leadEmail); });
                                 console.log('[retell-callback] Onboarding email sent to ' + leadEmail);
                     } catch (err) {
                                 console.error('[retell-callback] Email send failed:', err.message);
                     }
           }

           return res.json({ success: true, leadId, callStatus, outcome, meetingInterested, bookingLinkSent, AI_Call_Count: currentCallCount });
});

// Health Check
app.get('/health', (req, res) => {
        res.json({
                  status: 'ok',
                  // --- ROUTE 3: One-time requeue — reschedule 9PM IST follow-up for all past leads with AI_Call_Count < 3 ---
                // Skips: Interested, Not Interested, Completed, Max Calls Reached, no phone
                // Call this once: POST /admin/requeue-pending-leads  (protected by WEBHOOK_SECRET)
                app.post('/admin/requeue-pending-leads', async (req, res) => {
                          const { secret } = req.body;
                          if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
                                      return res.status(403).json({ error: 'Unauthorized' });
                          }
                        
                          const TERMINAL = ['Interested', 'Not Interested', 'Completed', 'Max Calls Reached'];
                          const baseUrl = ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
                          let page = 1;
                          const perPage = 200;
                          let queued = 0;
                          let skipped = 0;
                          let errors = 0;
                          let totalFetched = 0;
                        
                          console.log('[requeue] Starting requeue of pending leads...');
                        
                          try {
                                      while (true) {
                                                    const token = await getZohoAccessToken();
                                                    // Fetch leads page by page, selecting only the fields we need
                                                    const searchRes = await axios.get(`${baseUrl}/crm/v3/Leads`, {
                                                                    headers: { Authorization: `Zoho-oauthtoken ${token}` },
                                                                    params: {
                                                                                      fields: 'id,First_Name,Last_Name,Phone,Email,Company,AI_Call_Count,AI_Last_Call_Status',
                                                                                      per_page: perPage,
                                                                                      page: page
                                                                            }
                                                    });
                                              
                                                    const leads = (searchRes.data && searchRes.data.data) || [];
                                                    totalFetched += leads.length;
                                              
                                                    if (leads.length === 0) break;
                                              
                                                    for (const lead of leads) {
                                                                    const callCount = parseInt(lead.AI_Call_Count || '0', 10);
                                                                    const status = (lead.AI_Last_Call_Status || '').trim();
                                                                    const phone = lead.Phone || '';
                                                            
                                                                    // Skip: already at max, terminal status, or no phone
                                                                    if (callCount >= MAX_CALLS_PER_LEAD) { skipped++; continue; }
                                                                    if (TERMINAL.includes(status)) { skipped++; continue; }
                                                                    if (!phone) { skipped++; continue; }
                                                                    // Skip leads never called (callCount = 0) — they will be triggered by Zoho webhook naturally
                                                                    if (callCount === 0) { skipped++; continue; }
                                                            
                                                                    const leadObj = {
                                                                                      id: lead.id,
                                                                                      name: ((lead.First_Name || '') + ' ' + (lead.Last_Name || '')).trim() || 'Valued Lead',
                                                                                      phone: phone,
                                                                                      email: lead.Email || '',
                                                                                      company: lead.Company || ''
                                                                    };
                                                            
                                                                    try {
                                                                                      const delayMs = getDelayUntilNext9PMIST();
                                                                                      const fireAt = new Date(Date.now() + delayMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' UTC';
                                                                                      await safeUpdateZohoLead(lead.id, {
                                                                                                          AI_Last_Call_Status: 'Follow-Up Scheduled',
                                                                                                          AI_Follow_Up_Scheduled: fireAt
                                                                                              });
                                                                                      scheduleFollowUpCall(leadObj, delayMs);
                                                                                      console.log(`[requeue] Scheduled lead ${lead.id} (${leadObj.name}) callCount=${callCount} -> 9PM IST today`);
                                                                                      queued++;
                                                                    } catch (err) {
                                                                                      console.error(`[requeue] Failed to schedule lead ${lead.id}:`, err.message);
                                                                                      errors++;
                                                                    }
                                                    }
                                              
                                                    // Check if there are more pages
                                                    const info = searchRes.data && searchRes.data.info;
                                                    if (!info || !info.more_records) break;
                                                    page++;
                                      }
                          } catch (err) {
                                      console.error('[requeue] Fatal error fetching leads:', err.message);
                                      return res.status(500).json({ error: 'Failed to fetch leads', details: err.message, queued, skipped, errors });
                          }
                        
                          console.log(`[requeue] Done. Total fetched=${totalFetched}, queued=${queued}, skipped=${skipped}, errors=${errors}`);
                          return res.json({ success: true, totalFetched, queued, skipped, errors });
                });
        
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
        if (!code) return res.status(400).send('No code provided');
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
