# zoho-retell-middleware

> **Production-ready middleware** connecting Zoho CRM Leads to Retell AI outbound calling for **MakeYourLabel**.

## Architecture

```
New Lead Created in Zoho CRM
         │
         ▼
Zoho Webhook → POST /webhook/zoho-lead  (This server)
         │
         ▼
Retell AI places outbound call to lead
         │
    ┌────┴────┐
    │         │
 Interested  Not Interested
    │
    ▼
Retell Callback → POST /webhook/retell-callback
    │
    ├─► Update Zoho CRM (Status, Outcome, Summary, Recording, Transcript)
    └─► Send booking email: makeyourlabel.zohobookings.in/#/makeyourlabel
```

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/adyraysingh/zoho-retell-middleware.git
cd zoho-retell-middleware
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your real credentials
```

### 3. Run

```bash
npm run dev    # Development
npm start      # Production
```

---

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select `adyraysingh/zoho-retell-middleware`
4. Add all environment variables from `.env.example`
5. Copy your Railway URL and update the Zoho CRM webhook

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `RETELL_API_KEY` | Retell AI API key |
| `RETELL_AGENT_ID` | Retell AI agent ID |
| `RETELL_FROM_NUMBER` | Outbound number in E.164 format |
| `ZOHO_CLIENT_ID` | Zoho OAuth client ID |
| `ZOHO_CLIENT_SECRET` | Zoho OAuth client secret |
| `ZOHO_REFRESH_TOKEN` | Zoho OAuth refresh token |
| `ZOHO_API_DOMAIN` | e.g. https://www.zohoapis.in |
| `WEBHOOK_SECRET` | Shared secret to validate Zoho webhooks |
| `FROM_EMAIL` | Sender email for booking link emails |

---

## API Endpoints

### POST /webhook/zoho-lead
Receives new lead data from Zoho CRM and triggers Retell call.

### POST /webhook/retell-callback
Receives post-call data from Retell AI. Updates CRM fields:
- `AI_Last_Call_Status`, `AI_Last_Call_Date`
- `Call_Outcome`, `Meeting_Interested`, `Booking_Link_Sent`
- `Call_Summary`, `Recording_URL`, `Transcript_URL`

If lead is interested → sends booking email automatically.

### GET /health
Health check endpoint.

---

## Zoho CRM Webhook Config

**URL:** `https://YOUR-RAILWAY-URL.up.railway.app/webhook/zoho-lead`
**Method:** POST
**Body (JSON):**
```json
{
  "webhook_secret": "YOUR_WEBHOOK_SECRET",
  "id": "${Leads.Lead Id}",
  "First_Name": "${Leads.First Name}",
  "Last_Name": "${Leads.Last Name}",
  "Phone": "${Leads.Phone}",
  "Email": "${Leads.Email}",
  "Company": "${Leads.Company}"
}
```

---

## Required Zoho CRM Custom Fields

| Field Label | API Name | Type |
|---|---|---|
| AI Last Call Date | AI_Last_Call_Date | DateTime |
| AI Last Call Status | AI_Last_Call_Status | Pick List |
| Call Outcome | Call_Outcome | Pick List |
| Meeting Interested | Meeting_Interested | Pick List (Yes/No) |
| Booking Link Sent | Booking_Link_Sent | Pick List (Yes/No) |
| Call Summary | Call_Summary | Multi-Line Text |
| Recording URL | Recording_URL | URL |
| Transcript URL | Transcript_URL | URL |

---

## Features

- Triggers Retell AI call on new Zoho CRM lead
- Passes lead name, phone, email to AI agent
- Analyzes transcript to determine qualification outcome
- Updates 8 CRM fields after each call
- Sends booking email when lead is interested
- Retry logic (3 attempts) for API failures
- Zoho OAuth token caching and auto-refresh
- Structured logging

---

## License

MIT © MakeYourLabel
