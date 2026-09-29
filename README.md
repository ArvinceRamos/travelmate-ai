# Travelmate AI

Travelmate AI is a travel-planning app with chat-based itinerary planning, saved itineraries, place search, map pins, directions, and weather. The local development path uses Firebase emulators and a local AI provider, so it does not require a Firebase project, paid API account, or billing setup.

## Tech Stack

- React 18, Vite, Leaflet, and OpenStreetMap tiles
- Firebase Authentication, Firestore, Storage, and Cloud Functions emulators
- Node.js 20 Cloud Functions API
- Photon place search, Nominatim reverse geocoding, Overpass nearby places, and OSRM routing
- Open-Meteo weather
- Configurable AI provider: Ollama locally, or Gemini with a server-side key

## Local Setup

Requirements: Node.js 20, Java 21 or later for the Firestore emulator, and the Firebase CLI. The public map/weather endpoints need internet access. Ollama is optional if using a hosted AI provider.

1. Install dependencies from the repository root and each app directory:

   ```powershell
   npm install
   npm install --prefix apps/web
   npm install --prefix apps/functions
   ```

2. Copy the example environment file for the frontend and backend:

   ```powershell
   Copy-Item .env.example apps/web/.env
   Copy-Item .env.example apps/functions/.env
   ```

   The example uses the Firebase demo project ID `demo-travelmate`, emulator mode, and placeholder Firebase web config. Do not replace it with a real project ID for local emulator use. The VAPID placeholder disables push notifications; the rest of the app can run without push setup.

3. Install Ollama from [ollama.com](https://ollama.com), then download a model:

   ```powershell
   ollama pull qwen2.5:7b
   ```

   Keep Ollama running. The example backend settings use `AI_PROVIDER=ollama`, `AI_MODEL=qwen2.5:7b`, and `AI_BASE_URL=http://127.0.0.1:11434`. Choose a smaller model if your machine has limited memory.

4. In terminal one, start the local Firebase services:

   ```powershell
   $env:FUNCTIONS_DISCOVERY_TIMEOUT = "30"
   firebase.cmd emulators:start --project demo-travelmate --only auth,firestore,storage,functions
   ```

5. In terminal two, start the frontend:

   ```powershell
   npm run dev --prefix apps/web
   ```

   Open the local URL printed by Vite (normally `http://localhost:5173`). The emulator UI is at `http://127.0.0.1:4000`.

The demo project ID prevents accidental access to live Firebase resources. The Functions emulator serves the API at `http://127.0.0.1:5001/demo-travelmate/asia-southeast1/api`. Emulator data is local and may be cleared when the emulators stop unless you configure import/export.

## Optional Hosted AI

Ollama is the no-key default. For a hosted demo, choose one hosted provider in `apps/functions/.env` and keep its key out of the frontend:

- **Gemini:** create a key in [Google AI Studio](https://aistudio.google.com/app/apikey), set `AI_PROVIDER=gemini`, `AI_MODEL=gemini-2.5-flash`, and `GEMINI_API_KEY=...`. Free-tier quotas are model/project-specific and shown in AI Studio; they are not guaranteed. Keep billing disabled for the no-billing hosted demo. The backend limits chat to 10 requests/minute per IP and honors provider `Retry-After` responses.

Optional fallback configuration is available through `AI_FALLBACK_PROVIDER`, `AI_FALLBACK_MODEL`, and `AI_FALLBACK_BASE_URL`. Fallbacks are only attempted after primary-provider errors. Never put the Gemini key in a `VITE_*` variable.

## Free Data Services

- **Map tiles:** the public OpenStreetMap tile service is used by default. Keep the visible `© OpenStreetMap contributors` attribution. The public tile service is best-effort, has no SLA, and prohibits bulk downloading/prefetching; use a compliant tile provider or self-host for substantial traffic.
- **Search:** Photon powers autocomplete and place lookups. Its public instance is rate-limited and has no availability guarantee; use it politely and cache responses. The base URL can be changed with `PHOTON_BASE_URL` on the backend and `VITE_PHOTON_BASE_URL` in the frontend.
- **Reverse geocoding:** Nominatim is only used for deliberate reverse lookups, not autocomplete. The adapter queues requests at no more than one per second per running backend instance and caches results. Set a descriptive `NOMINATIM_USER_AGENT` with a real project contact before public deployment. The public service may block abusive clients and has no SLA.
- **Nearby POIs:** Overpass queries have a bounded radius and result count and are cached. The public service asks users to stay around 10,000 queries/day and under 1 GB/day; shared instances can return 429/504 during busy periods.
- **Routes:** OSRM provides road routes for driving, walking, or cycling. Public demo infrastructure is best-effort; transit, live traffic, and guaranteed ETAs are not available.
- **Weather:** Open-Meteo requires no API key for non-commercial use, subject to its published fair-use limits (currently 10,000 calls/day, 5,000/hour, and 600/minute). Weather responses and screens attribute Open-Meteo; its data is licensed CC BY 4.0. Check the current terms before commercial use.

Public endpoints can rate-limit or change without notice. The app caches map/weather responses, bounds queries, shows friendly errors, and does not fabricate missing place data. Ratings and business hours are unknown unless actual source data provides hours; transit and traffic are unavailable. Public endpoint availability is not guaranteed.

## Configuration

`.env.example` documents frontend and backend variables. Local files belong in `apps/web/.env` and `apps/functions/.env`; they are ignored by Git. Backend AI keys are server-side only. Photon, Nominatim, Overpass, OSRM, and Open-Meteo base URLs can be overridden with the corresponding backend variables. The OSM tile URL is configurable with `VITE_OSM_TILE_URL`.

For a deployed frontend, set `VITE_USE_FIREBASE_EMULATORS=false`, provide your own Firebase project settings, and set `VITE_API_BASE_URL` to the API you operate. A hosted AI key belongs only in the backend's secret/environment configuration. Do not assume free public endpoints or free hosting have production SLAs.

## Deployment options

Local: run Firebase Auth, Firestore, Storage, and Functions emulators with Ollama for keyless AI, as described in Local Setup.

Hosted demo: Firebase Auth and Firestore can stay on Spark, but Cloud Functions and Firebase Storage require Blaze. A Render backend would need a standalone Express refactor estimated at 1-2 engineering days.

A no-billing demo can use a static frontend host (Firebase Hosting Spark, Vercel, or Netlify) with Firebase Auth and Firestore on Spark, plus a separate free backend host. Firebase Auth/Firestore Spark quotas are finite (Firestore currently includes 1 GiB storage, 50,000 reads/day, and 20,000 writes/deletes per day; Auth limits depend on provider). Firebase Cloud Functions requires Blaze, and Firebase Storage requires Blaze, so neither is suitable for the strict no-billing hosted path. Avatar uploads therefore work with the local Storage emulator but are unavailable on a Spark-only deployment.

The current backend remains a Firebase Function for local emulation. Moving it to standalone Express for a Render free web service is a moderate refactor: roughly 1-2 engineering days, including replacing the Functions export/secret/scheduler wrappers, porting the reminder worker to an external scheduler or disabling it for the demo, and validating Firebase Admin auth and CORS. It is not part of this migration. Render free web services sleep after 15 minutes idle, may take about a minute to wake, and use ephemeral storage; this is suitable for a portfolio demo, not a production SLA.

## Screenshots

<!-- Replace these placeholders with current screenshots before publishing. -->

![Travelmate AI chat](<img width="1913" height="909" alt="chat travelmate" src="https://github.com/user-attachments/assets/d10bcc69-56f9-4fbc-a09f-a84d73c633a2" />
)

![Travelmate AI map](<img width="1917" height="909" alt="viewmaps travelmate" src="https://github.com/user-attachments/assets/c46f1a1a-df8d-4cf3-a549-480d98120a71" />
)

![Travelmate AI itinerary](<img width="1917" height="910" alt="saved itinerary" src="https://github.com/user-attachments/assets/66c4bad0-5581-4473-9a6b-d1b2ecf9086c" />
)

## Known Limitations

- No transit directions or real-time traffic.
- Ratings, review counts, and opening hours are unknown unless explicitly returned by the data source; the app does not infer them.
- Public Photon, Nominatim, Overpass, OSRM, and OpenStreetMap tile services are community infrastructure, not production SLAs.
- Hosted AI free quotas are limited and can change. Ollama is the most predictable zero-key local option, but requires local compute and model storage.
- Firebase demo emulators do not persist data after shutdown by default.
- Push notifications require separate VAPID configuration and are not part of the default local setup.
