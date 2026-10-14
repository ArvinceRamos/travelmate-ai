# Handoff: fast place search + fewer "Not found on map" stops

Project: `C:\Users\arvince\.vscode\travelmate-ai-public`, branch `codex/free-api-migration` (last commit `38bb5f0`). Read `AGENTS.md` first. Rules: $0 only, never commit keys, ask before committing/pushing/deploying or changing Vercel/Firebase, keep diffs focused, check every UI change at 360×640, 390×844, 768×1024, 1280×800 and 844×390. Files in `apps/web/src` are CRLF: edit with the Edit tool or `perl`, never Git Bash `sed -i`.

Previous work (see `docs/HANDOFF_MAPS_PERFORMANCE.md`, all done and pushed): one shared parser (`apps/web/src/utils/itineraryParse.js`), stops geocoded once and saved on the itinerary as `mapGeo` (`apps/web/src/features/maps/tripGeo.js`), per-day numbering, "Not found on map" list, autocomplete cache, code-splitting. Stop geocoding now goes through the backend `GET /v1/places/geocode` (Nominatim, 1 req/s queue, `geocodePlace` in `apps/functions/src/services/freeProviders.service.js`), with Photon as fallback (`geocodeTripStop` near the top of `apps/web/src/pages/MapPage.jsx`).

## What the user sees now

1. **Place search is unusable.** Typing "sm j" (wanting SM J Mall, Mandaue/Cebu) shows "Searching…" for 20–30 s, then wrong results (SM Sains Johor, SM City Jinjiang). Typing "Sm" shows nothing. The user wants Google-Maps-like behavior: suggestions after the first letter, instantly, relevant to where they are.
2. **Siargao trip: 13 of 18 stops on the map.** Not found: "Mactan-Cebu International Airport", "General Luna Boulevard", "Kermit Siargao", "Shaka Siargao", "General Luna Public Market". The Cebu/Moalboal trip resolves 14/14.

## Causes (measured 2026-10-15)

### Search
- Public Photon (`photon.komoot.io`) answers in **8–10 s even for "s"** (20–27 s on 2026-10-14). No client tuning fixes that. Nominatim is ~1 s but its usage policy **forbids autocomplete**.
- The main search box gets **no location bias**: `MapPage.jsx` renders `<PlacesAutocompleteInput inputId="tm_place_search" …>` without `biasCenter`, so results are global.
- `PlacesAutocompleteInput.jsx` waits for 3 characters (`MIN_QUERY_LENGTH`), debounces 200 ms, and has no request timeout, so a slow request leaves "Searching…" up indefinitely.

### Siargao misses
- **Airport (found, then rejected by us):** Nominatim finds Mactan-Cebu International Airport (~10.31, 123.98), but `tripOutlierKeys` in `tripGeo.js` drops it: it's ~300 km from the Siargao stops and the trip radius is `max(150 km, 4 × median distance)`. The rule should not reject a hit whose name clearly matches the stop.
- **Extra area words break the query:** with a Siargao viewbox, Nominatim returns nothing for "Kermit Siargao" or "Shaka Siargao", but finds "Kermit" (9.788, 126.160) and "Shaka Cafe" (9.812, 126.164). "General Luna Public Market" and "General Luna Boulevard" return nothing as full strings.
- **Misses are cached forever:** `mapGeo.places` stores `{ k, q, missing: true }` and the resolver never retries it, so even a better resolver won't fix trips already opened. The user's Siargao trip is one of those.

## Plan

### A. Autocomplete that feels instant (main work)

1. **Fast provider (user decision needed first).** Recommend **Geoapify Autocomplete**. Its free plan (checked 2026-10-15 on geoapify.com/pricing): 3,000 credits/day, up to 5 req/s, no credit card, commercial use allowed, attribution required. Confirm on its "Pricing details" page that an autocomplete request costs 1 credit. Alternative: LocationIQ (5,000 req/day, 2 req/s, backlink required; their page doesn't clearly say autocomplete is included). Google Places needs a billing account, so it's out under the $0 rule.
   - Ask the user to create the account and key (Claude must not create accounts). Prefer a **browser key restricted to allowed origins** (`http://localhost:5173`, `https://travelmate-ai-psi.vercel.app`) as `VITE_GEOAPIFY_KEY`: no Vercel cold start, lowest latency. If the user wants it server-side, proxy through a new `GET /v1/places/autocomplete` with an in-memory cache and keep the key in Vercel env only. Never commit the key. Add the variable name to `.env.example`.
   - Call it with `text`, `bias=proximity:<lon>,<lat>` from the current map center, `lang=en`, `limit=6`. Fall back to Photon only if no key is set or the request fails. Show the required "Powered by Geoapify" attribution in the dropdown footer.
2. **Instant local suggestions from the first character**, shown before any network reply: recent searches/picks (store the last ~20 in `localStorage` per user, wrapped in try/catch), plus stops from the user's saved itineraries that already have coordinates in `mapGeo`. Prefix-match on each word. This is what makes "S" show something immediately, like Google's history rows.
3. **Input behavior** in `apps/web/src/features/maps/PlacesAutocompleteInput.jsx`: remote lookup from **2 characters** (local from 1), debounce ~120 ms, keep the 5-minute in-memory cache, abort stale requests (already done), **4 s timeout** that shows "Search is slow right now, press Enter to search" instead of an endless "Searching…". Keep previous results visible while loading. Merge local rows on top of remote rows without duplicates.
4. **Pass `biasCenter`** to the main search input from the Leaflet map center, updated on `moveend` (round to 2 decimals so the cache still hits). Do the same for the directions origin/destination inputs.
5. Keep the request budget in mind: 3,000/day. Debounce, cache, minimum length and aborting keep a typical search to 2–4 requests.

### B. Fewer "Not found" stops

1. **Outlier rule** (`tripOutlierKeys` / `pickHit` in `tripGeo.js`): only reject far results that are weak matches. Keep a far hit when its name shares ≥2 meaningful words with the stop, or the stop looks like a transport hub (airport, port, pier, terminal, station). The airport case must stay on the map.
2. **Query fallbacks in the backend** (`geocodePlace` in `freeProviders.service.js`, still through the 1 req/s Nominatim queue): if the bounded viewbox search returns nothing, retry once with words that repeat the trip base removed ("Kermit Siargao" → "Kermit", "Shaka Siargao" → "Shaka"). The web side should pass the base label (e.g. `base=Siargao`) so the backend knows which words to strip. Cap the total at 3 Nominatim calls per stop.
3. **Optional, if 1–2 still leave common misses:** an Overpass lookup by name inside the trip's bounding box (e.g. `nwr["name"~"<word>",i](bbox)`, or `amenity=marketplace` for "public market"). A quick curl to `overpass-api.de` returned **406 Not Acceptable**; it likely needs a proper `User-Agent` and `Content-Type: application/x-www-form-urlencoded`. Verify before relying on it, keep it server-side, cache results, and keep it to one request per missing stop.
4. **Retry old misses once:** bump `MAP_GEO_VERSION` to 2 (still read v1), or store a resolver version on `missing` entries. Entries marked missing by an older resolver get retried once and then stored with the new version. Found entries are kept as they are.
5. **Flight legs and the route:** after the airport resolves, Day 1 goes Cebu airport → Sayak Airport (Siargao). OSRM driving can't cross that sea, so the whole itinerary route may fail ("No route was found"). Build the route per segment: skip or draw a straight dashed line for legs between two airports or longer than ~150 km, and request OSRM only for drivable runs. Keep the 20-point limit per request.

## Acceptance

- Typing "s" in the map search shows local suggestions immediately (recents or trip stops). With a Geoapify key and the map over Cebu, "sm j" shows "SM J Mall" (or the closest data match) within ~500 ms on a normal connection. No "Searching…" longer than 4 s.
- Suggestions are biased to the visible map area; Cebu searches don't put Malaysia or China first.
- The Siargao trip shows the Mactan-Cebu airport, Kermit and Shaka on the map. Anything still missing has a clear reason in the panel. Its old cached misses are retried once without the user doing anything.
- Panagsama fixture still 5 / 5 / 4, all 14 found. `npm test` passes in `apps/web` and `apps/functions`, `npm run build` passes with no chunk over 500 KB.
- Request budget: a typical search stays at 2–4 remote requests. Geocoding a new trip makes at most 3 Nominatim calls per stop.

## Verification setup (worked on 2026-10-14)

- Emulators: `firebase emulators:start --only auth,firestore --project demo-travelmate`. They may already be running (ports 9099/8080, hub 4400); check first.
- Emulator sign-ups must be marked verified: POST `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-travelmate/accounts:update` with `Authorization: Bearer owner` and `{ "localId": "<uid>", "emailVerified": true }`. Seed itineraries with the Firestore REST API (`Bearer owner`), including an `updatedAt` timestamp. Use `apps/web/test/fixtures/panagsama.txt` and a Siargao itinerary with the five failing stops above.
- In emulator mode the web app calls the API at `http://127.0.0.1:5001/demo-travelmate/asia-southeast1/api`. Don't use the functions emulator (it loads `apps/functions/.env` with old paid keys). Instead, mount `app.js`'s exported `app` in a small Express server at that path, with `AI_PROVIDER=ollama`, `CORS_ALLOWED_ORIGINS=http://localhost:5173` and `NODE_PATH=apps/functions/node_modules`.
- Run Vite with `npx vite --port 5173` in `apps/web`; the browser pane can open `http://localhost:5173`.
- Check at all five sizes, run both test suites and the build, then summarize and **ask before committing**. Backend changes need a Vercel redeploy of the API project; ask the user.

## Order of work

1. Ask the user: Geoapify (recommended) or another provider, and browser key vs backend proxy. Ask them to create the key and put it in `apps/web/.env` (local) and Vercel env (live).
2. B1 + B4 (outlier rule and retrying old misses). Small, testable in `apps/web/test/tripGeo.test.js`, fixes the airport right away.
3. B2 (query fallbacks), with tests in `apps/functions/test/geocode.test.cjs`.
4. A2–A4 (local suggestions, input behavior, bias). These help even before a key exists.
5. A1 (provider) once the key exists.
6. B5 (flight legs / route segments), then B3 only if needed.
7. Verify, summarize, ask before commit.
