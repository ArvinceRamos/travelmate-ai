# TravelMate AI — Vercel Deployment Checklist

This checklist walks through deploying TravelMate AI to Vercel (free) with Firebase Spark and free AI providers. Follow in order. All services are free and require no payment method.

**Repository:** `ArvinceRamos/travelmate-ai`, branch `codex/free-api-migration`  
**Deployment cost:** $0 (Vercel Hobby + Firebase Spark + Gemini/Groq free tiers)

---

## A. Firebase Setup (Spark Plan)

- [ ] Log into [Firebase Console](https://console.firebase.google.com) with your Google account.
- [ ] Create or use an existing Firebase project for this app (ensure it is on **Spark plan**, not Blaze).

### A1. Enable Authentication

- [ ] In the project, go to **Authentication > Sign-in method**.
- [ ] Enable **Email/Password** provider.
- [ ] Enable **Google** provider (you'll configure the OAuth client below).
- [ ] Go to **Settings > Authorized domains**.
- [ ] Note your two Vercel project domains:
  - Web project: `<project-name>-web.vercel.app`
  - API project: `<project-name>-api.vercel.app`
  - (These are TBD until you create the Vercel projects; for now, remember you must add them here after creating Vercel projects.)

### A2. Deploy Firestore Rules

- [ ] In `C:\Users\arvince\.vscode\travelmate-ai-public`, open a terminal.
- [ ] Ensure you're logged into Firebase CLI:
  ```powershell
  firebase login
  ```
- [ ] Deploy the Firestore rules:
  ```powershell
  firebase deploy --only firestore:rules
  ```

### A3. Create a Service Account Key

- [ ] In Firebase Console, go to **Project settings > Service accounts**.
- [ ] Click **Generate new private key**.
- [ ] A JSON file downloads. Keep it safe—do not commit it.
- [ ] Open it and copy the entire JSON content to use in Vercel (step D2).

### A4. Add Authorized Domains (After Creating Vercel Projects)

- [ ] Once you've created both Vercel projects (step C below), return here.
- [ ] In Firebase **Settings > Authorized domains**, add both `*.vercel.app` domains under "Authorized domains".

---

## B. AI API Keys (Free Tier)

Both free tiers require no payment method and have rate limits suitable for a demo.

### B1. Gemini (Primary AI)

- [ ] Go to [Google AI Studio](https://aistudio.google.com/app/apikey).
- [ ] Click **Create API Key**.
- [ ] Copy the key (you'll paste it into Vercel environment in step D3).
- [ ] Note: the free tier is per model. On 2026-10-15 the Flash-Lite models allowed 15 requests/min and 500/day; the full Flash models only 20/day, which is too few for this app (one trip uses about 15 requests). Check your project's limits at [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit) with **All models** switched on.

### B2. Groq (Optional — not needed for the recommended setup)

- [ ] Go to [Groq Console](https://console.groq.com/keys).
- [ ] Sign in or create a free account (no card required).
- [ ] Copy your API key (you'll paste it into Vercel environment in step D3).
- [ ] Note: Default model is `openai/gpt-oss-120b` (`llama-3.3-70b-versatile` was shut down on 2026-08-16). Groq's free 8K tokens/minute is smaller than the itinerary prompt, so a second Gemini model is the better fallback.

---

## C. Create Vercel Projects (Two Separate Projects)

You will create two separate Vercel projects from the same GitHub repository, each with a different root directory.

### C1. API Project (`apps/functions`)

- [ ] Go to [Vercel Dashboard](https://vercel.com/dashboard).
- [ ] Click **Add New > Project**.
- [ ] Select your GitHub repo `ArvinceRamos/travelmate-ai` (authorize if prompted).
- [ ] **Framework Preset:** Node.js.
- [ ] **Root Directory:** `apps/functions`.
- [ ] **Project Name:** `travelmate-api` (or your choice; the `<api>` part of `https://<api>.vercel.app`).
- [ ] Do **not** add environment variables yet; you'll do that in step D.
- [ ] Click **Deploy**.
- [ ] Wait for the build to complete. Once it says "Ready", note the URL: `https://<travelmate-api>.vercel.app`.
- [ ] Verify the API is live by visiting `https://<travelmate-api>.vercel.app/health` (should respond with 200 and `{ "status": "ok" }`). If it shows "Unauthorized" or "500", skip this for now; environment variables are not yet set (step D3).

### C2. Web Project (`apps/web`)

- [ ] In the Vercel Dashboard, click **Add New > Project** again.
- [ ] Select the same GitHub repo.
- [ ] **Framework Preset:** Vite (or autodetected).
- [ ] **Root Directory:** `apps/web`.
- [ ] **Project Name:** `travelmate-web` (or your choice; the `<web>` part of `https://<web>.vercel.app`).
- [ ] Do **not** add environment variables yet; you'll do that in step D.
- [ ] Click **Deploy**.
- [ ] Wait for the build to complete. Once "Ready", note the URL: `https://<travelmate-web>.vercel.app`.

---

## D. Set Environment Variables on Vercel

### D1. API Project Environment Variables

- [ ] Go to the Vercel **travelmate-api** project > **Settings > Environment Variables**.
- [ ] Add the following variables (copy the exact names and values):

| Name | Value |
|------|-------|
| `AI_PROVIDER` | `gemini` |
| `AI_MODEL` | `gemini-3.5-flash-lite` |
| `GEMINI_API_KEY` | (paste from B1) |
| `AI_FALLBACK_PROVIDER` | `gemini` |
| `AI_FALLBACK_MODEL` | `gemini-3.1-flash-lite` |
| `AI_MAX_TOKENS` | `4096` |
| `LLM_FIRST_INTAKE` | `1` |
| `FIREBASE_SERVICE_ACCOUNT` | (paste the entire service-account JSON from A3, on a single line with no extra spaces) |
| `CRON_SECRET` | (generate a long random string, e.g., 32+ random characters; keep it secret) |
| `CORS_ALLOWED_ORIGINS` | `https://<travelmate-web>.vercel.app` (replace with your actual web project URL) |
| `NOMINATIM_USER_AGENT` | `TravelMate-Capstone/1.0 (you@example.com)` (replace with your contact email) |

- [ ] After adding all variables, click **Save**.
- [ ] The API project will automatically redeploy. Wait for "Ready".
- [ ] Once ready, verify the API again at `https://<travelmate-api>.vercel.app/health` (should now respond with `{ "status": "ok" }`).

### D2. Web Project Environment Variables

- [ ] Go to the Vercel **travelmate-web** project > **Settings > Environment Variables**.
- [ ] Add the following variables:

| Name | Value |
|------|-------|
| `VITE_FIREBASE_API_KEY` | (your Firebase web config API key; see below) |
| `VITE_FIREBASE_AUTH_DOMAIN` | (your Firebase auth domain; see below) |
| `VITE_FIREBASE_PROJECT_ID` | (your Firebase project ID; see below) |
| `VITE_FIREBASE_STORAGE_BUCKET` | (your Firebase storage bucket; see below) |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | (your Firebase messaging sender ID; see below) |
| `VITE_FIREBASE_APP_ID` | (your Firebase app ID; see below) |
| `VITE_FIREBASE_VAPID_KEY` | (your Firebase VAPID key for push notifications; see below) |
| `VITE_USE_FIREBASE_EMULATORS` | `false` |
| `VITE_API_BASE_URL` | `https://<travelmate-api>.vercel.app` (replace with your actual API project URL) |
| `VITE_ENABLE_AVATAR_UPLOADS` | `false` |

#### Where to Find Firebase Web Config Values

- [ ] In [Firebase Console](https://console.firebase.google.com), go to **Project settings > Your apps**.
- [ ] Select the web app (or create one if needed).
- [ ] Copy the configuration object; it will look like:
  ```javascript
  const firebaseConfig = {
    apiKey: "...",
    authDomain: "...",
    projectId: "...",
    storageBucket: "...",
    messagingSenderId: "...",
    appId: "...",
  };
  ```
- [ ] Paste the values into the corresponding Vercel environment variables above.
- [ ] For `VITE_FIREBASE_VAPID_KEY`, you can use a placeholder (e.g., `disabled`) or generate one with `npm run generate-vapid` in `apps/web` if you want push notifications working.

- [ ] After adding all variables, click **Save**.
- [ ] The web project will automatically redeploy. Wait for "Ready".
- [ ] Once ready, visit `https://<travelmate-web>.vercel.app` and confirm the app loads.

### D3. Add Vercel Domains to Firebase Authorized Domains (Final Step)

- [ ] Go back to [Firebase Console](https://console.firebase.google.com) > **Authentication > Settings > Authorized domains**.
- [ ] Add both Vercel project domains:
  - `<travelmate-web>.vercel.app`
  - `<travelmate-api>.vercel.app`
- [ ] Save.

---

## E. Set Up External Cron (Reminders)

TravelMate uses reminders (notifications for upcoming itineraries). The backend processes them with a worker function; you need an external cron job to trigger it every 5 minutes.

- [ ] Go to [cron-job.org](https://cron-job.org) (free account, no card required).
- [ ] Sign up or log in.
- [ ] Create a new cron job:
  - **URL:** `https://<travelmate-api>.vercel.app/v1/cron/reminders`
  - **Method:** POST
  - **Schedule:** every 5 minutes (or select a cron expression like `*/5 * * * *`)
  - **Headers:** Add a header `Authorization: Bearer <CRON_SECRET>` (use the secret you generated in D1)
- [ ] Save the job.
- [ ] Test it manually:
  - In your terminal, run:
    ```powershell
    $uri = "https://<travelmate-api>.vercel.app/v1/cron/reminders"
    $headers = @{ Authorization = "Bearer <CRON_SECRET>" }
    Invoke-WebRequest -Uri $uri -Method Post -Headers $headers
    ```
  - It should respond with `200 OK`. If it says `401`, double-check the secret.

---

## F. Verification

### F1. Check Backend Health

- [ ] Visit `https://<travelmate-api>.vercel.app/health` in your browser.
- [ ] Should respond: `{ "status": "ok" }`.

### F2. Test the Web App

- [ ] Visit `https://<travelmate-web>.vercel.app`.
- [ ] [ ] Log in with **Email/Password** (use a test email).
- [ ] [ ] Log out and log in with **Google**.
- [ ] [ ] Generate an itinerary (chat; should respond with text).
- [ ] [ ] View the Map page (should load tiles and allow search).
- [ ] [ ] View Itinerary (should display saved trip).
- [ ] [ ] View Settings.

### F3. Test AI Fallback (Optional but Recommended)

- [ ] To confirm the fallback works, temporarily set `AI_MODEL` to a model that doesn't exist (e.g., `gemini-does-not-exist`) and redeploy.
- [ ] Trigger a chat message. It should still answer through `AI_FALLBACK_MODEL`, and the logs should show `[ai] provider failed` with the primary model's 404.
- [ ] Restore `AI_MODEL` and redeploy.

### F4. Responsive Design Check (Optional)

- [ ] On the live web app, use browser DevTools to check responsive sizes:
  - **Phone (360×640):** No horizontal scroll, all controls reachable.
  - **Tablet (768×1024):** Sidebar drawer opens/closes, content readable.
  - **Desktop (1280×800):** Full layout, all features visible.
- [ ] Test on actual devices if possible (phone, tablet).

---

## G. Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| **API returns 500** | Missing or invalid env vars | Check Vercel > Settings > Environment Variables; redeploy after changes. |
| **API returns 401 on /health** | Missing `FIREBASE_SERVICE_ACCOUNT` | Paste the full service-account JSON (on one line) into Vercel env. |
| **Web loads but chat is blank** | `VITE_API_BASE_URL` is wrong | In Vercel web project, check `VITE_API_BASE_URL` matches your actual API URL (no trailing slash). |
| **Chat says "The AI planner is temporarily unavailable"** | Both AI models failed | Vercel > API project > Logs, search `primary and fallback providers failed`: it lists provider, model, status and message for both. 404 = model name wrong or retired; 429 = free quota used up; 400 = bad key. |
| **Chat says "The AI is busy right now"** | Free per-minute quota hit on both models | Wait a minute; check the limits in AI Studio. |
| **Cron job returns 401** | `CRON_SECRET` doesn't match header | In cron-job.org, check the `Authorization` header includes the exact secret (case-sensitive). |
| **Firebase Auth fails** | Vercel domain not in authorized domains | In Firebase Console, add the `*.vercel.app` domain under Authentication > Settings > Authorized domains. |
| **Vercel build fails** | Missing `VITE_FIREBASE_*` env vars on web project | Add all six Firebase config vars (API Key, Auth Domain, Project ID, etc.) to the web project env. |

---

## H. Next Steps

- **Cleanup** (optional): Delete the old `travelmate_Capstone2` folder if no longer needed (it's a backup).
- **Monitor** (optional): Set up Vercel deploy notifications to your email.
- **Custom Domain** (optional): Vercel allows you to add a custom domain for free under your account.

---

## Summary

You now have:
- ✅ TravelMate AI live at `https://<travelmate-web>.vercel.app`
- ✅ Backend API at `https://<travelmate-api>.vercel.app`
- ✅ Reminders running via free cron-job.org
- ✅ AI with Gemini (free tier) + Groq fallback
- ✅ All data in Firebase Spark (Auth, Firestore; no billing)
- ✅ Fully responsive design (360px to 1280px+)
- ✅ $0 cost
