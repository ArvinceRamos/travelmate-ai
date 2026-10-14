# Handoff: make the map correct and the app faster

Project: `C:\Users\arvince\.vscode\travelmate-ai-public`, branch `codex/free-api-migration`. Read `AGENTS.md` first (rules: $0 only, never commit keys, ask before committing/pushing/changing Vercel or Firebase, keep diffs focused, check every UI change at 360×640, 390×844, 768×1024, 1280×800 and 844×390).

The app is now live: web `https://travelmate-ai-psi.vercel.app`, API `https://travelmate-ai-2knu.vercel.app`. The redesign is done; this task is about **behavior and speed**, not looks.

## What the user sees

1. **Wrong number of itinerary stops.** The saved "Panagsama Beach • May 25–27" trip lists 14 stops (Day 1: 5, Day 2: 5, Day 3: 4) but the map shows 12, and stops that are listed can be missing or wrong.
2. **Wrong per-day numbering.** On "Day 2" of the Siargao trip the pins are numbered 1, 2, 5, 6 instead of 1–N for that day.
3. **"Mapping itinerary stops…" is slow** every time an itinerary or day is opened.
4. **Pins stay after closing the Itineraries panel**, and the place-search pin stays on the map together with itinerary pins.
5. **Search autocomplete is laggy.**
6. **The whole app feels slow** (first load, page switches, chat replies).

## Likely causes, verified in the code

### Stop parsing: `apps/web/src/features/maps/itineraryStops.js` (`parseItineraryStops`)
- Saved itineraries now use a **multi-line format** per stop:
  ```
  1. 07:00–10:00
  Cebu City to Moalboal
  Leave Cebu early by private car, …
  ```
  The parser is **line-based**: the "strict" regex only matches a one-line `HH:MM–HH:MM - Place - Description`. In the new format the time line, the place line and the description line are each treated as separate candidates. The place line works by luck; description lines can become junk candidates or be dropped by the word-count/keyword filters.
- **Deduplication removes repeats across the whole trip:** `[...new Set(candidates)]` per day and again for `all`. "Panagsama Beach" (Day 1, Day 3) and "Moalboal Panagsama Beach" collapse, so the count drops.
- **Transfer lines** like "Cebu City to Moalboal" are not recognized as legs. They're geocoded as one place or dropped.
- `ItineraryPage.jsx` has its own `parseItinerary` with different regexes. The two parsers disagree, so the list and the map can never be guaranteed to match.

### Stop resolution: `apps/web/src/pages/MapPage.jsx` (around lines 1130–1235, `resolvePlaceFromQuery` around 883)
- Every stop is geocoded **in the browser** against public Photon (3 parallel workers), with `"<stop>, <anchor>"` and a 50 km circle around the anchor.
- Results more than **80 km from the anchor are silently dropped** (`if (roughKm > 80) continue;`). Cebu City is about 90 km from Moalboal, so trip legs to or from the city vanish.
- Pins get `label: "0"` and are numbered later from the combined order, not per day. That explains 1, 2, 5, 6 on Day 2.
- Nothing is persisted: each open, day switch, or new device re-geocodes everything. The `mapStops` field exists in `itineraryStore.jsx` ("structured map data, preferred by Maps") but is only filled when the chat reply carried it.

### Panel and pins: `MapPage.jsx`
- Closing the panel (`setItineraryPanelOpen(false)`) only hides it. Pins and route are cleared only by **Clear** (`clearItineraryView`, ~line 507).
- Search markers and itinerary pins are rendered together. There is no rule for which one wins.

### Autocomplete: `apps/web/src/features/maps/PlacesAutocompleteInput.jsx`
- 250 ms debounce, starts at 2 characters, calls public Photon directly, clears results (`setItems([])`) on every keystroke so the list flickers. There is no per-query cache.

### General speed
- `npm run build` warns that the single JS bundle is **about 1.1 MB** (340 KB gzipped). Leaflet, the map page, settings and chat all load up front.
- The API runs on Vercel serverless: the first request after idle has a cold start, and Gemini replies take several seconds.

## How it should behave (acceptance criteria)

**Stops**
- Every timed entry in a saved itinerary is a stop, in order, numbered **per day starting at 1** (Day 2 shows 1–5). "All days" numbers them 1–N across the trip or shows "Day 1 · 3", whichever is clearer. Pick one and keep it consistent.
- The same place on different days appears once per day. Within a day, consecutive duplicates may merge.
- A leg like "A to B" appears as a route segment between A and B, not as one ambiguous pin. If that's too much for now, show B and mark it as a transfer.
- The Panagsama fixture below must show **5 / 5 / 4** stops for Day 1 / 2 / 3, and the itinerary page and the map must agree.
- If a stop can't be found, show it in the panel list as "Not found on map" instead of silently dropping it. No hidden 80 km cutoff: use a per-trip bounding area from the resolved stops instead.

**Speed**
- Geocode each stop **once**, when the itinerary is saved or first opened, and store `lat`/`lng` (plus the matched name) on the itinerary doc, e.g. in `mapStops`. Opening a trip after that draws pins instantly, with no network calls.
- When an itinerary is edited, re-geocode only the stops whose text changed.
- Pins appear progressively as they resolve, rather than after all finish.

**Panel and pins**
- Closing the panel (✕) **hides the itinerary pins and route**. Reopening the panel restores the last itinerary and day without re-geocoding.
- **Clear** unselects the itinerary.
- A place search replaces the previous search pin, and doesn't mix with itinerary pins: viewing an itinerary hides search pins, and a new search hides the itinerary pins.

**Autocomplete**
- Suggestions show within about 300 ms of typing pause on a normal connection. Previous results stay visible while new ones load (no flicker). Repeat queries come from an in-memory cache. Start at 3 characters. Stale requests are aborted (already done).

**General**
- Code-split routes with `React.lazy`, especially Map (Leaflet), Settings and Notifications, so `/chat` loads a much smaller bundle. Target: no chunk over 500 KB.
- Show a typing/thinking state immediately when a chat message is sent; keep it.

## Test fixture (Panagsama Beach, expected 5 / 5 / 4)

```
Day 1 — May 25

1. 07:00–10:00
Cebu City to Moalboal
Leave Cebu early by private car, van, or bus and expect about 3–4 hours on the road depending on traffic and stopovers.
2. 11:15–12:30
Smooth Cafe Moalboal
Have a relaxed snack near the dive strip; good for a couple-friendly first meal and easy access from Panagsama.
3. 13:00–15:00
Panagsama Beach
Spend the afternoon by the shore, snorkel if conditions are calm, or just enjoy the laid-back beach atmosphere.
4. 15:15–17:00
Moalboal Sardine Run area
Go for a snorkel session or shoreline viewing near Panagsama, and bring reef-safe sunscreen and water shoes.
5. 18:00–19:30
Three Bears Restaurant
Enjoy dinner in the Panagsama area with an easy, unhurried evening meal.

Day 2 — May 26

1. 09:30–12:00
Kawasan Falls
Head to Badian for the main nature stop of the trip; expect around 1–1.5 hours each way from Moalboal depending on traffic.
2. 12:15–13:15
Badian
Take lunch near the falls area and keep cash ready since smaller places may not accept cards.
3. 13:25–14:05
Moalboal Panagsama Beach
Relaxed coastal stop near the sardine-run area; verify sea conditions before swimming.
4. 16:30–18:00
Basdaku White Beach
Wind down at the beach on the way back to Moalboal for a slower sunset stretch.
5. 18:30–20:00
Kumbira Restaurant & Bar
Have dinner back in Panagsama and keep the night easy after a full outdoor day.

Day 3 — May 27

1. 07:00–08:00
Panagsama Beach
Check out early and keep the morning light so the return trip stays comfortable.
2. 08:15–10:00
White Beach, Moalboal
Enjoy one last coastal stop before leaving, with time for photos and a short walk on the sand.
3. 10:15–11:15
French Bakery Ô Délices
Grab a late breakfast or coffee before heading out, especially if you want a slower exit from Moalboal.
4. 11:30–15:00
Moalboal to Cebu City
Return to Cebu by van or bus and allow extra time for traffic, especially on a Sunday or holiday.
```

Also keep supporting the older one-line format (`09:00-11:00 - Place - Description`) and the `Day 1 — Title` headers.

## Suggested order of work

1. **One shared parser** (e.g. `apps/web/src/utils/itineraryParse.js`) used by both `ItineraryPage.jsx` and the map. Unit tests with the fixture above plus the one-line format. The web app has no test runner yet; adding `node --test` for pure utils is enough.
2. **Persisted geocoding**: resolve once, save to the itinerary doc, reuse. Check `firestore.rules` allows the update.
3. **Map behavior**: per-day numbering, panel close hides pins, search vs itinerary pins, not-found list, remove the 80 km cutoff.
4. **Autocomplete**: cache, keep old results while loading, 3-character minimum.
5. **Bundle split** with `React.lazy`.
6. Verify in the browser with the Firebase emulators (`firebase emulators:start --only auth,firestore --project demo-travelmate`, throwaway user, seeded itineraries; navigate with `history.pushState` + `popstate`). Run `npm test` in `apps/functions` and `npm run build` in `apps/web`. Summarize and ask before committing.

## Constraints

- Photon and Nominatim are free community services: keep requests low, keep the 1 req/s Nominatim queue on the backend, cache aggressively, never loop-geocode on every render.
- No paid geocoding or map APIs.
