# TravelMate AI — agent guide

Student capstone: an AI travel planner (chat → itinerary, map, reminders). Owner: Arvince (GitHub `ArvinceRamos`).

## Which folder is the real project
- **Work here:** `C:\Users\arvince\.vscode\travelmate-ai-public` → GitHub `ArvinceRamos/travelmate-ai`, branch `codex/free-api-migration`.
- `C:\Users\arvince\.vscode\travelmate_Capstone2` (GitHub `ArvinceRamos/TravelmateAI`) is the **older** original copy (one commit behind, plus logs/zips/scratch tests). Do not edit it unless the user asks. Its `apps/functions/src/SERPER_PATCH.txt` contains a plaintext API key — never copy or commit it.

## Stack
- **Root:** npm, no workspaces. `firebase.json`, `.firebaserc` (project `travelmateai-5a3a8`), `firestore.rules`, `storage.rules`, `.env.example`.
- **`apps/web`:** React 18 + Vite 7, react-router 6, react-leaflet, plain global CSS in `src/styles/*.css` (imported in order in `src/main.jsx`; later files win on clashes). No Tailwind/UI library. `npm run build` runs `scripts/build-sw.mjs` (needs the six `VITE_FIREBASE_*` vars) then `vite build` → `dist/`. `vercel.json` already has an SPA rewrite.
- **`apps/functions`:** Express app inside Firebase Functions v2 (Node 20). `index.js` builds the app and exports `api` (`onRequest`, ~line 1277) and `reminderWorker` (`onSchedule` every minute, ~line 1528). `src/services/llm.service.js` is huge (~1.1 MB); avoid reading it whole. `src/app.js` and `src/routes/*` are unused. Tests: `npm test` (`test/*.test.cjs`).
- **`packages/shared`:** unused.
- Frontend calls the backend with `fetch(`${VITE_API_BASE_URL}/v1/...`)` + Firebase ID token (`apps/web/src/services/apiClient.js`). Saved trips, chats and notifications go to Firestore directly from the browser.

## External services (all free; keep it that way)
- AI: `src/services/aiProvider.service.js` — providers `ollama` (local default), `gemini`, `openai` (paid — do not use for deploy). Env: `AI_PROVIDER`, `AI_MODEL`, `AI_FALLBACK_PROVIDER`, `GEMINI_API_KEY`, …
- Geo/travel: `src/services/freeProviders.service.js` — Photon, Nominatim (1 req/s queue, needs `NOMINATIM_USER_AGENT`), Overpass, OSRM, Open-Meteo. Map tiles: OSM via `VITE_OSM_TILE_URL`.
- Firebase: Auth, Firestore, FCM (free on Spark). Storage avatars need Blaze → keep `VITE_ENABLE_AVATAR_UPLOADS=false`.

## Hard rules
- **$0 only.** No paid APIs, no Firebase Blaze-only features (Cloud Functions deploy, Scheduler, Secret Manager, Storage).
- Never commit `.env` files or keys. Local `apps/functions/.env` holds old paid keys — never copy them to Vercel or docs.
- Don't push, open PRs, or change Vercel/Firebase settings without asking the user. Commit only when asked.
- Every UI change must be checked in a browser at phone (360×640, 390×844), tablet (768×1024) and desktop (1280×800) sizes.
- Keep diffs focused; no comments unless the "why" is non-obvious.

## Current task: free deploy on Vercel + fully responsive site
Full plan with file/line references: **`docs/DEPLOY_FREE_VERCEL_PLAN.md`**. Read it before starting.

Decisions already made by the user (don't re-ask):
- Deploy from **travelmate-ai-public**.
- AI: **Gemini primary, Groq fallback** (add a `groq` provider; OpenAI-compatible API).
- Reminders: **free external cron (cron-job.org) every 5 min** hitting a secret-protected endpoint.
- Two Vercel projects: `apps/web` (static) and `apps/functions` (Express as one serverless function). Firebase stays on Spark.

### Status (update this checklist as you go)
- [x] 1. Extract Express app + reminder sweep from `apps/functions/index.js` into `apps/functions/app.js`; `index.js` imports it
- [x] 2. `apps/functions/api/index.js` + `apps/functions/vercel.json` (rewrite to `/api`, maxDuration 120, includeFiles `src/prompts/**`)
- [x] 3. Admin init from `FIREBASE_SERVICE_ACCOUNT` env (index.js ~line 26)
- [x] 4. `POST /v1/cron/reminders` guarded by `CRON_SECRET`; secure/remove `/v1/debug/run-reminders`
- [x] 5. `groq` provider in `aiProvider.service.js` + test
- [x] 6. `.unref()` on `setInterval` in `src/middleware/rateLimit.js`
- [x] 7. Remove `console.log` of BASE_URL in `apps/web/src/services/apiClient.js`
- [x] 8. Responsive fixes (Part 3 of the plan, items 1–9)
- [x] 9. `npm test` (functions) + `npm run build` (web) pass
- [x] 10. Browser responsive check of every route at all sizes, no horizontal scroll
- [x] 11. Update `.env.example` + README "Deploy to Vercel (free)" section and give the user the manual checklist
