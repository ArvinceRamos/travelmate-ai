# TravelMate: free deploy on Vercel + fully responsive site

## Context
The goal is to show TravelMate to clients on a public Vercel URL at **$0**, with the site working well on desktop, tablet and phones (360–430px wide).

**Project to use:** `C:\Users\arvince\.vscode\travelmate-ai-public` (GitHub `ArvinceRamos/travelmate-ai`, branch `codex/free-api-migration`). Its code matches `travelmate_Capstone2` except one newer commit (OpenAI support), and it has none of the logs, zips or scratch tests.

**Why it isn't free today**
- The backend is a Firebase Cloud Function (`exports.api`, `apps/functions/index.js:1277`). The reminder job (`exports.reminderWorker`, `:1528`) is scheduled every minute. Both need the paid **Blaze** plan.
- The AI defaults to Ollama on localhost, which won't exist once hosted.
- `apiClient.js:5` falls back to the local emulator unless `VITE_USE_FIREBASE_EMULATORS=false` is set.

**What is free (researched 2026-10-09)**
- **Vercel Hobby:** no card, 300s function limit, 1M invocations a month. It's for non-commercial use, which a capstone or portfolio demo is. If a client pays for it, that becomes commercial use.
- **Firebase Spark:** Auth, Firestore (50K reads a day) and FCM are free. Functions and Storage need Blaze.
- **AI:** Gemini Flash and Groq both have free tiers with no card.
- **Map and place data:** OSM tiles, Photon, Nominatim, Overpass, OSRM and Open-Meteo are already wired in and free.

## Target architecture ($0)
- **Vercel project A, "travelmate-web":** root `apps/web`, Vite static build (`vercel.json` SPA rewrite already exists).
- **Vercel project B, "travelmate-api":** root `apps/functions`, the existing Express app served as one Node serverless function.
- **Firebase Spark:** Auth, Firestore and FCM only. No Functions deploy. Avatar uploads stay off (`VITE_ENABLE_AVATAR_UPLOADS=false`).
- **AI:** Gemini (`gemini-2.5-flash`) first, Groq (`llama-3.3-70b-versatile`) as fallback.
- **Reminders:** cron-job.org (free) calls a secured endpoint every 5 minutes.

## Part 1: Backend runs on Vercel
1. **Extract the Express app.** Move app construction (middleware, CORS, routes; roughly `index.js:460–1275`) and the reminder logic into `apps/functions/app.js`, exporting `{ app, runReminderSweep }`. `index.js` imports from it, so the Firebase emulator keeps working.
2. **Add the Vercel entry point.** `apps/functions/api/index.js` does `module.exports = require("../app").app`.
3. **Add `apps/functions/vercel.json`.**
   - Rewrite `/(.*)` to `/api`.
   - Set `functions["api/index.js"]` to `maxDuration: 120`.
   - Include `src/prompts/**` via `includeFiles`, because `index.js:516` reads `systemPrompt.txt`.
4. **Admin credentials** (`index.js:26`). If `FIREBASE_SERVICE_ACCOUNT` (JSON) is set, call `admin.initializeApp({ credential: admin.credential.cert(JSON.parse(...)) })`. Otherwise keep the current call.
5. **Cron endpoint.** Add `POST /v1/cron/reminders`, guarded by `Authorization: Bearer ${CRON_SECRET}`, which calls `runReminderSweep()`. Also protect the unauthenticated `/v1/debug/run-reminders` (`:1267`) with the same check, or remove it.
6. **Groq provider.** Add a `groq` provider in `src/services/aiProvider.service.js`.
   - Reuse the existing OpenAI-compatible branch with base `https://api.groq.com/openai/v1`, key `GROQ_API_KEY` and default model `llama-3.3-70b-versatile`.
   - Extend `test/aiProvider.test.cjs`.
7. **Rate-limiter timer.** Add `.unref()` to the `setInterval` in `src/middleware/rateLimit.js:11` so it doesn't keep the function alive. The limiter stays per-instance, which is fine for a demo.
8. **CORS.** Set `CORS_ALLOWED_ORIGINS` to the web project URL.

**Backend env vars on Vercel:**
- `AI_PROVIDER=gemini`, `GEMINI_API_KEY`
- `AI_FALLBACK_PROVIDER=groq`, `GROQ_API_KEY`
- `FIREBASE_SERVICE_ACCOUNT`, `CRON_SECRET`, `CORS_ALLOWED_ORIGINS`
- `NOMINATIM_USER_AGENT="TravelMate-Capstone/1.0 (contact email)"`

## Part 2: Frontend on Vercel
**Frontend env vars:**
- The six `VITE_FIREBASE_*` values (`scripts/build-sw.mjs` fails without them).
- `VITE_FIREBASE_VAPID_KEY`
- `VITE_USE_FIREBASE_EMULATORS=false`
- `VITE_API_BASE_URL=https://<travelmate-api>.vercel.app`
- `VITE_ENABLE_AVATAR_UPLOADS=false`

Also remove the `console.log` of `BASE_URL` (`apiClient.js:11`).

**Manual steps for you** (I'll give a checklist):
- Make sure Firebase is on Spark.
- Add the `*.vercel.app` domain to Auth's authorized domains (needed for Google sign-in).
- Deploy rules with `firebase deploy --only firestore:rules`.
- Generate a service-account key.
- Get a Gemini key from AI Studio and a Groq key.
- Create both Vercel projects from the GitHub repo.
- Set up the cron-job.org job.

## Part 3: Responsive website (desktop, tablet and phones)
The audit is verified against the code. The app already has a viewport meta tag, `100dvh`, safe-area padding and a sidebar drawer at 900px and below. These are the fixes that remain, most severe first. All paths are under `apps/web/src/`.

1. **Breakpoint tokens.** Add a shared set to `styles/globals.css`: 1100 / 900 / 640 / 390px. New media queries use these.
2. **Auth modal can't scroll and is cut off on phones.**
   - Cause: `styles/auth.css:31` overlay is centered with no scroll, `.tm-authShell` has `min-height:700px`, and a duplicate `.tm-modalOverlay` sits at `settings.css:358`.
   - Fix: make one shared overlay with `overflow-y:auto; max-height:100dvh; align-items:flex-start` on small screens, drop `min-height` at 860px and below, and remove the duplicate.
3. **Notification menus open off-screen.**
   - Cause: `pages/NotificationsPage.jsx:332,339` uses `x = rect.right` with a 220px menu.
   - Fix: clamp `x` as `Sidebar.jsx:124-140` does: `Math.max(12, Math.min(rect.right - 220, innerWidth - 232))`.
4. **Chat welcome screen is clipped on 360×640.**
   - Cause: `styles/chat.css:46` sets `overflow:hidden` while empty, plus the absolutely positioned `.tm-empty` (`:314`).
   - Fix: allow scrolling, make the empty state flow normally (not absolute) at 640px and below, and use smaller or horizontally scrollable suggestion cards on phones.
5. **Map controls cover the map on phones** (`styles/maps.css` ~959–1100).
   - Use a compact one-row control bar with 44px icon buttons.
   - Make panels bottom sheets with `max-height: 50dvh`.
   - Keep the map `height:100%` inside the locked shell (no `height:auto`).
6. **Class name clashes.**
   - `.tm-iconBtn` exists in `chat.css:615` and `settings.css:403`, and settings wins, so chat buttons shrink to 34px. Scope it as `.tm-settings .tm-iconBtn`.
   - `.tm-miniBtn` clashes between `itinerary.css` and `maps.css:870`. Scope both.
7. **Tap targets.** Set a minimum of 44×44px at 640px and below for `.tm-notifKebab`, `.tm-ellipsisBtn`, map icon buttons and the sidebar toggle.
8. **Itinerary on phones.** At 960px and below, show the list OR the detail, with a "← Trips" back button. This reuses the existing selected-itinerary state in `ItineraryPage.jsx`, so there's no scroll area inside the page scroll.
9. **Sweep for horizontal overflow.** On every route at 360px, check that `document.documentElement.scrollWidth <= innerWidth`, and fix any offenders (long words or URLs get `overflow-wrap:anywhere`).

## Verification
**Backend**
- `npm test` in `apps/functions`, including the new Groq provider test.

**Frontend**
- `npm run build` in `apps/web`.
- **Responsive check** in the built-in browser (`vite preview`), using the viewport tool:
  - **Sizes:** 360×640, 390×844, 768×1024, 1280×800, and phone landscape 844×390.
  - **Routes:** logged-out home, auth modal, `/chat` (empty state and a conversation), `/map`, `/itinerary`, `/notifications` (open the menus), `/settings`.
  - **What to check:**
    - No horizontal scroll (JS check above).
    - Every control is reachable.
    - The modal scrolls.
    - Menus stay on screen.
    - The sidebar drawer opens and closes.
  - Take screenshots for each page.

**After you deploy**
- Hit `https://<api>.vercel.app/health`.
- On the live site:
  - Log in with email and with Google.
  - Generate an itinerary (confirm Gemini responds).
  - Temporarily set an invalid `GEMINI_API_KEY` in a preview deployment to confirm the Groq fallback.
  - Map search and route.
  - Weather.
- Trigger the cron URL manually with the secret and confirm a 200.

## Security notes
- `travelmate_Capstone2/apps/functions/src/SERPER_PATCH.txt` contains a plaintext Serper API key. Never commit it, and rotate the key.
- Local `apps/functions/.env` files hold old paid keys (OpenAI, Amadeus and others). Don't copy them into Vercel, and consider revoking unused ones.
- Only the Firebase **web** config is public by design. The service-account JSON and AI keys go only into the API project's env vars.
