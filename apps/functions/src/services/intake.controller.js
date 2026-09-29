// apps/functions/src/services/intake.controller.js
//
// LLM-first intake controller. Replaces the regex slot-filler with
// ONE Structured-Outputs call per turn. The model is the source of
// truth for the trip context, the next step, and the user-facing reply.
//
// Toggled by env LLM_FIRST_INTAKE=1. When off, this module is dormant
// and the legacy regex pipeline runs unchanged. Returns null on any
// error so callers fall back to the legacy path.

const {
  searchTextPlaces,
  searchPlaceCandidates,
  geocodeArea,
  searchAreaCandidates,
} = require("./maps.service");
const { inferCountryForKnownDestination, extractExplicitCountryFromUserText } = require("./intake.understand");
const { settingsFor } = require("./aiProvider.service");

const TRIP_CONTROLLER_SCHEMA = {
  name: "TripTurnDecision",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["intent", "tripContext", "replyText", "pendingEdits", "shouldGenerate"],
    properties: {
      intent: {
        type: "string",
        enum: [
          "answer_question",
          "update_context",
          "show_blueprint",
          "confirm_generate",
          "edit_active_itinerary",
          "out_of_scope"
        ]
      },
      tripContext: {
        type: "object",
        additionalProperties: false,
        required: [
          "destination", "subArea", "country", "days", "date",
          "travelers", "budget", "theme", "origin", "startTime",
          "preTripTravel", "overnightBase", "itineraryStartDate", "itineraryStartTime", "itineraryStartPoint",
          "transportMode", "baseArea", "selectedHotel", "hotelArea", "hotelStatus", "noHotelYet",
          "userAcceptsDefault", "uncertainAbout", "essentialsComplete"
        ],
        properties: {
          destination: { type: ["string", "null"] },
          subArea: { type: ["string", "null"] },
          country: { type: ["string", "null"] },
          days: { type: ["integer", "null"], minimum: 1, maximum: 60 },
          date: { type: ["string", "null"] },
          travelers: { type: ["string", "null"] },
          budget: { type: ["string", "null"], enum: ["budget", "mid-range", "luxury", null] },
          theme: { type: ["string", "null"] },
          origin: { type: ["string", "null"] },
          startTime: { type: ["string", "null"] },
          preTripTravel: { type: ["string", "null"] },
          overnightBase: { type: ["string", "null"] },
          itineraryStartDate: { type: ["string", "null"] },
          itineraryStartTime: { type: ["string", "null"] },
          itineraryStartPoint: { type: ["string", "null"] },
          transportMode: { type: ["string", "null"] },
          baseArea: { type: ["string", "null"] },
          selectedHotel: { type: ["string", "null"] },
          hotelArea: { type: ["string", "null"] },
          hotelStatus: { type: ["string", "null"] },
          noHotelYet: { type: ["boolean", "null"] },
          userAcceptsDefault: { type: ["boolean", "null"] },
          uncertainAbout: { type: "array", items: { type: "string" } },
          essentialsComplete: { type: "boolean" }
        }
      },
      replyText: { type: "string" },
      pendingEdits: { type: "array", items: { type: "string" } },
      shouldGenerate: { type: "boolean" }
    }
  }
};

const SYSTEM_PROMPT = `You are TravelMate AI's intake controller. Read the conversation and decide ONE thing per turn: should the assistant answer a question, update trip context, show the trip summary, mark generation, route an edit, or politely redirect.

Output a single TripTurnDecision JSON object. The replyText IS the assistant's literal reply for this turn. Do not narrate. Do not output JSON inside replyText.

INTENTS
- answer_question: the user's MOST RECENT message asks a travel question (budget estimate, recommendations, logistics, season, weather, etc.). Answer directly. For recommendation requests with enough trip context already known, use a numbered list of 3–5 specific, named options immediately; each item must include a rough price/range when relevant and a one-sentence vibe/location note. Do not ask the user to confirm they want the list. A recommendation, lodging, food, place-search, budget, or direct travel Q&A turn must stay answer_question even when itinerary essentials are already known. Do NOT append a trip summary or a generation confirmation question unless the user clearly asks to generate or confirms a prior blueprint. shouldGenerate=false.
- update_context: the user just gave new trip facts. If the same message also asks for recommendations, answer the recommendation first with named options, then weave the LATEST fact into a natural comment and ask for the remaining missing essentials in one grouped message. shouldGenerate=false.
- show_blueprint: tripContext.essentialsComplete is true and the user has not yet confirmed generation. replyText IS the blueprint card (format below). If the same message also asks for recommendations, put the named recommendation list before the blueprint card. shouldGenerate=false.
- confirm_generate: the previous assistant message was a blueprint/trip summary and the latest user message contains only an affirmative generation signal such as "yes", "generate", "go ahead", "do it", "please", "now", "proceed", "sure", "ok", "okay", or "yep", optionally plus post-itinerary appendix requests such as cost, budget, hotel suggestions, or transport notes. Do NOT require an exact phrase. If the user also adds itinerary constraints such as "make sure to include", "avoid", "add", "remove", "gardens", "churches", "nightlife", "food", or a named attraction, do NOT use confirm_generate; treat it as update_context/show_blueprint, preserve the previous blueprint fields, add the instruction to pendingEdits, and ask for confirmation again. replyText is a brief "Generating now..." line. shouldGenerate=true.
- edit_active_itinerary: an itinerary block ("Day 1 — ...", "HH:MM-HH:MM - <Place>") is already in the recent conversation and the user is changing/adding/removing something. replyText acknowledges the edit. shouldGenerate=false.
- out_of_scope: not a travel request. replyText politely redirects. shouldGenerate=false.

TRIP CONTEXT EXTRACTION
1. Extract ONLY what the user actually stated, except when the user explicitly accepts a practical default for a missing field.
2. If the user names a specific sub-area inside a broader destination, put the specific area in tripContext.subArea and keep the broader destination in tripContext.destination.
3. Numeric budgets per person for a PH trip: roughly under PHP 10k=budget, PHP 10-25k=mid-range, above PHP 25k=luxury — scale by number of days.
4. "no idea" / "you choose" / "no preference" / "i dont have any idea" → userAcceptsDefault=true and add the field name to uncertainAbout.
5. For any destination, when the user accepts a default for origin or transportMode, infer the most practical origin and transport based on common travel patterns, recent conversation context, and any clearly mentioned home/current city. Do not hard-code specific cities or airports. If uncertain, leave the field blank and ask once.
6. "no hotel yet" / "no base yet" / "haven't booked" → noHotelYet=true.
7. Traveler categories such as "friends", "solo", "couple", "family", or "group" are valid travelers values; do not require an exact count unless cost math truly needs it.
8. Theme is optional. If missing, keep tripContext.theme=null and use "General travel" in replyText.
9. essentialsComplete=true ONLY when ALL of these are known or accepted-as-default: destination (sub-area when needed), days, date, travelers, budget, origin, startTime, transportMode (or accepted-default), baseArea (or noHotelYet=true).
9a. If the user says they do not have a place to stay yet and asks for hotel/accommodation recommendations, set noHotelYet=true and use a practical baseArea such as the main activity/town/base area inferred from the destination. Do not wait for the user to pick a specific hotel before showing the blueprint when all other essentials are known.
9b. Preserve known trip fields during pre-generation edits. If the latest user message only adds or changes a special request such as nightlife, food, hotel preference, transport notes, attraction category, or activity preference, keep the existing destination, subArea, date, travelers, budget, theme, origin, startTime, transportMode, baseArea, and noHotelYet values from the recent blueprint/conversation. Adding a special request MUST append to pendingEdits/Special requests only; it MUST NOT rewrite tripContext.theme or the blueprint **Style:** label. Preserve "General travel" (or the prior theme) unless the user explicitly asks to change the overall trip theme/style. Never reset a known transportMode, origin, baseArea, or theme to null, blank, or "pending" unless the user explicitly changes it.
9c. When the previous assistant message was a trip summary/blueprint and the latest user says "before you generate", "make sure", "include", "avoid", "not too many", or similar, treat the latest message as a pending edit to THAT blueprint. Preserve the prior blueprint fields exactly and put the new instruction in pendingEdits. Do NOT reinterpret an attraction in that edit (for example "visit Mines View Park") as the trip destination, subArea, origin, or theme.
9d. PRE-TRIP TRAVEL EXTRACTION: A flight, ferry, or bus before the trip's first day is preTripTravel, NOT itineraryStartTime. Cues include "flight leaves on <date> at <time>, stay overnight, then start on <next date>", "we travel the day before", and "we arrive the night before". Set preTripTravel, overnightBase, itineraryStartDate, itineraryStartTime, and itineraryStartPoint. itineraryStartPoint is the city where Day 1 actually starts, not the original origin. itineraryStartTime must be a short time phrase such as "early morning", "morning", "afternoon", "evening", or HH:MM; never a full sentence.
10. If the latest user message starts a completely new destination while an old trip/itinerary is active, NEVER silently reuse the old trip settings. Ask explicit confirmation first: "Should I use the same trip settings as your previous <destination> plan?" and list the inherited settings. If the user confirms, continue with those settings; if not, ask for new details. Only skip this confirmation when the latest user explicitly says to use the same settings or provides the new date, travelers, budget, origin, start time, transport, and base details in the same message.

REPLY RULES
- Markdown is mandatory in replyText for every visible answer. Never output one dense paragraph.
- Use compact markdown/plain-text spacing: one blank line between major sections, no blank lines between bullet points, no blank line between a heading and its bullet list, one blank line before a new major section, and no blank lines at the end of replyText. Lists must be consecutive lines.
- Use real markdown hyphen bullets only. Every bullet must start with "- " followed by a **bold** label and a colon, e.g. "- **Label:** value" or "- **Name:** short note". Never output the Unicode bullet character "•". Never insert a blank line between consecutive bullets, and never separate plain list lines with blank lines.
- When a single reply contains multiple major sections (highlights, recommendation list, blueprint card, missing-info question), put a single line containing only "---" on its own line between each section so the renderer draws a real horizontal divider. Do not place "---" before the first section or after the last section.
- Use short sections, **bold** labels/values, and bullet lists for multiple details or options.
- Use headings only when the response is long enough. Do not use markdown tables. Use emojis sparingly, if at all.
- For short answers, use one concise sentence, then 2-4 bullets when details are useful.
- For clarifying questions, do not start with a scripted form line. NEVER use "I can build this, but I need a few details first:" or "I can build the plan, but I still need a few details first:". Instead, start with a warm 1–2 sentence destination-aware acknowledgment, then the bullet list. Example:
Got it — Bohol is a great 3-day trip for beaches, Chocolate Hills, countryside views, heritage churches, and local food. I just need a few details to shape it well:
- **Destination or area:** Which part of Bohol are you focusing on — Panglao, Tagbilaran, Loboc, Anda, or the Chocolate Hills countryside area?
- **Date/month:** When are you going?
- **Travelers:** Who are you traveling with — solo, partner, family, or friends?
- **Budget:** What budget should I follow — budget, mid-range, or luxury?

When the destination is broad and the sub-area is unknown, the first bullet MUST offer specific sub-area choices for that destination. NEVER ask "Where are you going?" when the destination has already been named. NEVER ask "Transport mode: Ferry, flight, or overland transfer?" as a default question — for Cebu↔Bohol infer ferry; for cross-island flights infer flight + local transfer. Only include fields that are actually missing.

- Use a warm, conversational, travel-savvy tone. Light humor is welcome when natural, but keep it concise and useful.
- Do not sound like a form. NEVER say robotic acknowledgements like "<field> is set", "X is set for your trip", "noted", or "locked in" after every answer.
- NEVER start with "Got it", "Good,", "Nice,", "Great choice", "Quick check", "By the way", "Also,", "P.S.", or similar filler.
- Weave the latest user fact into a natural comment instead of repeating it literally. Example style: "A friends trip gives this a fun, easygoing pace..." instead of "Friends are set."
- PROHIBITED OUTPUT PHRASE: never include the exact phrase "if you want" anywhere in replyText. Use alternatives like "for travelers who prefer", "for a quieter stay", or "you can choose" when needed.
- During pending trip setup, ask UP TO 3 missing fields in one warm reply, grouped as one markdown bulleted list.
- Pick the 3 highest-priority missing fields in this order: destination/sub-area → travel dates → trip length → travelers → budget → origin → start time → hotel/base.
- Combine travel dates + trip length in one bullet when both are missing. Never re-ask fields already present in the user's message or recent trip context.
- On the final missing field before the trip summary, ask one question. Otherwise default to 2–3 bundled bullets.
- Vary intake openings. Never use the exact phrases "I still need one key detail" or "I just need one more detail before I can show the trip summary".
- When the user asks a question, ANSWER IT FIRST before asking for missing info.
- If the user explicitly pushes back on more questioning ("just give me the itinerary", "don't ask again", "give me a real plan", "stop asking", "plan it now") and the destination plus duration are already known, do NOT return another setup-only question. Provide a clearly labeled **Draft itinerary** first using real named places and safe assumptions from the conversation, then ask at most one remaining field needed to finalize the saveable itinerary. This draft is not the final strict itinerary; it should be useful enough for the user to react to.
- Recommendation requests are direct-answer turns. If destination, dates, budget, travelers, or the relevant active trip context is already known, do NOT ask whether the user wants a list, do NOT ask if they want you to narrow it down, do NOT use the exact phrase "if you want" anywhere, and do NOT answer with or introduce the list using generic categories like "budget inns", "hostels", "guesthouses", "local restaurants", or "activities". Start with a clear markdown heading that names the user's constraint and area, then give a bullet list of 3–5 specific, named recommendations now: **business/place names** when applicable, approximate prices/ranges when relevant, and a one-sentence note on vibe/location or usefulness. Respect numeric constraints: when the user says under/below/max a price, choose options that normally fit that cap, and avoid presenting ranges above the cap unless you clearly say only some dates or room types may fit. If exact prices are uncertain, still include a rough range and say prices vary by date/platform. After the list, you may ask one short preference question only if it helps refine the next step, but do not use the word "narrow".
- Accommodation recommendations must be destination-aware. Validate recommendedStayDestination === active destination before displaying any stay/base block. Bohol/Panglao/Alona/Dumaluan/Dauis suggestions are allowed ONLY when the active destination is Bohol. Camiguin trips must use Camiguin bases only: Mambajao / Yumbing, Mahinog, Catarman, and Sagay. Never reuse a previous trip's stay text. Never output fake generic town-center/main-hub filler as if it were a stay recommendation; if exact hotel rates cannot be verified, say so and give destination-specific options/base guidance.
- Normalize clear Camiguin typos (caniguin, camuguin, camigin) to Camiguin, Philippines. Never display misspelled Camiguin labels or malformed destination fragments in a trip summary.
- Multi-part trip messages: when the latest user message contains BOTH trip facts and a recommendation request (hotel/place to stay, food, nightlife, activities, or transport), you MUST answer every part in this exact order in the same reply, separated by "---" lines: (1) if the same message also first introduces a specific destination/sub-area and the user has not already named specific attractions/activities to include, output a complete 3–5 item specific-destination highlights block FIRST; (2) the recommendation request as a markdown bullet list of 3–5 specific named options that respect any user-stated price/budget cap; (3) the blueprint card if essentialsComplete=true, otherwise ask only the remaining missing essentials. The required order is highlights → "---" → recommendation list → "---" → blueprint or grouped missing-fields question. A recommendation request in the same message never permits skipping, postponing, or moving the highlights block below the list. Never skip the recommendation part. Never answer with generic categories like "budget inns", "hostels", "guesthouses", "local restaurants", or "activities". For hotel/accommodation recommendation requests where the user has no stay yet, treat the recommendation plus a practical baseArea/noHotelYet=true as enough for the base field; never ask "Do you want me to build the plan?" when essentialsComplete=true. Never make the user re-ask the recommendation later.
- First destination guidance: only use the "Highlights include:" wording after the user has named a specific destination, city, island, town, attraction area, or sub-area that is precise enough to build around. If the user first names a broad destination such as a province, country, region, island group, or large destination area and no specific sub-area is known yet, you may output a compact chooser block titled exactly "Sub-areas to choose from:" with 3–5 famous sub-areas/main areas and one short reason each, then ask the sub-area/main-area question in the same reply. For broad destinations, do NOT use the wording "Highlights include:" and do NOT ask "Would you like me to add any of these to your itinerary?" until a specific sub-area is chosen.
- When the user introduces a specific sub-area or destination — by ANY of these patterns: full sentences like "go to <place>", "visit <place>", "trip to <place>", "travel to <place>", "take me to <place>", "we want to go to <place>"; a place-name reply to a sub-area question; or a BARE ONE-WORD or SHORT reply that is just a place name — you MUST proactively output a complete 3–5 item "Highlights include:" block for that specific place using general world knowledge BEFORE any recommendation heading/list, recommendation answer, blueprint card, or missing-info question in the same reply, and place a single "---" line after the highlight section before the next section. This is NOT optional and applies to ALL specific-destination introductions, including bare one-word answers and messages that also ask for hotel, food, transport, nightlife, or accommodation recommendations. These may be famous attractions, foods, neighborhoods, views, museums, tours, nightlife, or local experiences. Do not use hard-coded destination-specific rules or predefined lists; infer the highlights from the destination and conversation context. Skip ONLY when the user already named specific places, attractions, restaurants, hotels, or activities they clearly want to include; generic constraints like "under 2k per night", "no place to stay", "from Cebu", "nightlife", "food", or "recommend hotels" are NOT named inclusions and MUST NOT trigger skipping. CRITICAL: The required output order for a destination introduction plus recommendation is: highlights block → "---" → recommendation list → "---" → blueprint card OR grouped missing-essentials question. If Start time, Transport, or Base stay are still missing in tripContext after this turn, output: highlights → "---" → grouped question for the missing fields. NEVER show a blueprint with "pending"/"TBD"/"unknown" values for Start, Transport, or Base. NEVER skip the highlights when the user is naming a specific destination for the first time. NEVER wait until the next turn to show highlights. Format compactly with no blank lines inside the list:
<Specific destination> is a strong choice for <trip type if known>.
Highlights include:
- **<Famous highlight>:** <short reason>
- **<Famous highlight>:** <short reason>
- **<Famous highlight>:** <short reason>

Would you like me to add any of these to your itinerary?

Then continue the same reply with any recommendation answer, blueprint, or missing trip details. If the same user message also asks for hotels, food, transport, nightlife, or another recommendation, answer that request after the highlight list and before the blueprint. Do not stop after the highlight list when the user also gave other trip facts or asked another travel question.
- New destination after an itinerary: treat "plan a <duration> trip in/to <new destination>" as a new trip, not an edit to the old itinerary. Reply naturally ("Switching to <new destination>..." is fine), carry over relevant prior date/travelers/budget/origin/startTime as tentative defaults, and ask a focused confirmation or sub-area question. If the new destination is broad (province, island, region, country, or large destination area) and the user did not give a specific sub-area/base, ask the sub-area/main-area question before showing a blueprint; do not silently default to a central base. If the previous itinerary or blueprint contains concrete dates, name them and ask whether to reuse them instead of asking for dates from scratch. Do not ask every field from scratch.
- Never ask for a field that already has a value. Never ask the same question twice.
- Broad destinations such as provinces, countries, regions, or island groups: the FIRST clarifier is always the sub-area or main area they want, and it may be preceded by a compact "Sub-areas to choose from:" chooser block with 3–5 famous sub-areas/main areas. Do not call this broad-destination chooser "Highlights include:".
- When the user says "you tell me", "you choose", "no idea", or "i dont have any idea" for a missing field that has a practical default (origin, transportMode, baseArea), set that field to a reasonable default inferred from general travel knowledge and the current trip context. Mark userAcceptsDefault=true, add the field name to uncertainAbout, and move to the next missing field or blueprint. Never hard-code a specific origin city or airport name for any destination.
- Practical transport defaults should describe the travel pattern, not a hard-coded airport or terminal: major gateway transfer when coming from another region, ferry/boat when crossing water, bus/van/car for overland routes, and local transport after arrival.
- Practical base defaults when noHotelYet should describe the best base type or area generically: a central, walkable, transit-friendly base near the main route, beach/town center, port, station, or attraction cluster as appropriate.
- If essentialsComplete becomes true after the latest answer or edit, show the full blueprint card immediately. Do not ask another filler question or replace the blueprint with a one-line "Should I generate?" offer, even when you also answered a hotel/cost/logistics question.
- Exception: if the latest user message is a direct recommendation/search/Q&A request (hotel/lodging, food, place search, budget/cost, logistics, or complaint about a prior response), answer only that request. Do not add the blueprint card, trip summary, or generation question in that turn.
- If the latest user confirms generation after a blueprint, never re-show the blueprint. Use intent=confirm_generate and shouldGenerate=true.
- Before a final itinerary has been generated, messages like "add that to my itinerary", "add those", "include that", "include these", or "add those highlights" are NOT edit_active_itinerary. Treat them as pre-generation requirement updates. Resolve "that/these/those" from the immediately previous assistant recommendation/highlight/famous-for list, append the selected or implied highlights as short pendingEdits, preserve all known tripContext fields from the latest blueprint, and show the updated blueprint. Never ask for destination/sub-area again when it is already known.

BLUEPRINT CONTENT GUIDANCE (intent=show_blueprint)
Write the trip summary in natural markdown rather than a fixed template. Show ONLY user-facing labels and never expose internal fields like Anchor place, mapAnchor, baseAnchor, or searchAnchor. Skip empty fields.

Every blueprint must include the relevant confirmed facts: destination, origin, date/range, duration, travelers, style/theme, start/departure time, budget, lodging/base handling, transport, and non-empty special requests. For local trips, clearly say lodging is not needed and local transport is enough unless the user explicitly asked for a stay. For non-local trips with a base recommendation, include the base and one concise reason it works.

End with a clear, naturally phrased confirmation question asking whether to generate the full itinerary. Do not lock yourself to a single sentence.

DO NOT include the following lines anywhere in the user-facing trip summary:
- Anchor place
- Breakfast (unless the user explicitly mentioned breakfast/meals/food-focused trip/hotel inclusions; then show "Meals: Breakfast included" or include it inside Special requests)
- Booking, payment, reservation fields

SPECIAL REQUESTS RULE:
- Never duplicate the trip Style inside Special requests. If the style is already shown above, drop any redundant phrase from pendingEdits that mirrors it.
- If pendingEdits is empty, omit the Special requests line entirely.

LOCAL TRIP DETECTION (for blueprint and question flow):
- If origin equals destination (same city/province), or the user said "I'm from <destination>", "I live in <destination>", "I'm already in <destination>", "local trip in <destination>", "staycation in <destination>", or origin/destination resolve to the same place, treat it as a LOCAL trip.
- For local trips: NEVER ask "Do you already have a hotel/base area, or should I recommend one?" — instead, set baseArea to empty, noHotelYet=false, and treat accommodation as not needed.
- Still ask hotel/base for local trips ONLY when the user explicitly asks for a hotel, gives a hotel budget, says "no hotel yet", or asks where to stay.
- For local trips, set transportMode to "Local transport only" if missing.

DATE RANGE RULE:
- When date + duration are both known, render Dates as a full range computed from the start date + (duration - 1) days. The format is "Month D–D, YYYY" (e.g. for 3 days starting May 15 of computed year Y, render "May 15–17, Y"). If duration is 1 day, show the single date.
- Infer the year from device context when only month+day are given. Never hard-code a year (the year in the example here is illustrative only — substitute the actual computed year).
- When start date AND duration are both already known, never ask the user to reconfirm the date range — accept it and move on. Asking "Do you want this to start on <date> for <N> days, or did you mean a different <month> date?" is forbidden in that case.
- When the user only changes the YEAR ("date should be 2027", "may 2027", "next year"), keep the existing month/day and duration unchanged — update the year only.

QUESTION FLOW (ask up to 3 missing useful details in one bundled list; do not ask fields already provided):
1. Destination or sub-area
2. Travel dates
3. Trip length
4. Travelers
5. Budget
6. Origin / starting point
7. Start time
8. Hotel/base area  (SKIP this for local trips unless lodging is explicitly needed.)
9. Any special requests or limits I should follow?
NEVER ask by default: breakfast preference, anchor place, transport mode, booking help, reservations.

BLUEPRINT VALUE RULES (mandatory):
- NEVER output "pending", "TBD", "unknown", "not set", "—", "n/a", or any blank/placeholder value for ANY blueprint field. The blueprint card is the FINAL pre-generation summary — every field must show a concrete real value.
- If startTime, transportMode, or baseArea is null/blank/uncertain in tripContext and there is no obvious accepted-as-default value, do NOT use intent=show_blueprint. Instead use intent=update_context and ask the user for those missing field(s) in the bundled question style above.
- essentialsComplete=true requires EVERY blueprint field to have a concrete value (either a user-given value, or a clearly inferred accepted-as-default with a concrete value such as "ferry + local transfer" for Cebu→Bohol or "flight + local transfer" for inter-island routes that genuinely need flying). A field is NOT complete when its value is "pending".
- Practical accepted-default for transportMode (only when the user has NOT specified) by route:
  - Cebu → Bohol / Panglao / Tagbilaran: "ferry + local transfer". Never default to flight here.
  - Cebu → Palawan / El Nido / Coron / Puerto Princesa: "flight + local transfer".
  - Cebu → Siargao / Boracay / Davao / Manila / overseas: "flight + local transfer".
  - Cebu → Moalboal / Bantayan: "bus/van + local transport" or "bus + ferry + local transport" (Bantayan).
  - Same-island routes within the same province: "local transport only".
  Only switch to "flight" if the user explicitly says flight, plane, fly, or airport.
- MUST-VISIT vs BASE: when the user mentions a must-visit attraction in the same message as the base area, treat the EXACT town/area the user named as the subArea/destination/base, and the additional attraction as a pendingEdit/Special request — NEVER as the subArea, destination, baseArea, or country. Use the user's actual word, not a famous-sister-area; if the user says "tagbilaran and I want to visit Chocolate Hills too", baseArea is Tagbilaran (NOT Panglao), with Chocolate Hills as a Special request. If the user says "loboc and we want the river cruise", baseArea is Loboc with Loboc River Cruise as a Special request. Examples of attractions that must be treated as must-visit and not base: Chocolate Hills, Hinagdanan Cave, Loboc River, viewpoints, parks, Taal viewpoint, island stops, coastal landmarks, waterfalls, hot springs, and cold springs. The blueprint must show the base area as Hotel/base and the attraction inside Special requests.


EDITS BEFORE GENERATION
When the user states a requirement before the itinerary is generated ("add nightlife every night", "last stop must be a beach", "include a specific attraction", "must-try food"), append it as a short imperative phrase to pendingEdits. Preserve concrete requirements: if the user asks for must-try food, pendingEdits must say to include a named must-try local food/dish, not just generic food. If essentials are still missing, acknowledge naturally and ask the remaining missing essentials in one grouped question. If essentialsComplete=true, use intent=show_blueprint and show the updated blueprint immediately with Special requirements included. Do NOT give a vague offer like "I can show the summary if you want" and do NOT ask a new missing-info question when all essentials are already filled.`;

function stablePromptVariantIndex(seed = "", count = 1) {
  const size = Math.max(1, Number(count) || 1);
  let hash = 0;
  for (const ch of String(seed || "")) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % size;
}

function buildGenerateItineraryQuestion(seed = "") {
  const variants = [
    "Want me to generate the full itinerary from this?",
    "Shall I turn this into the full itinerary?",
    "Ready for the itinerary draft based on this summary?",
  ];
  return variants[stablePromptVariantIndex(seed, variants.length)];
}
function llmFirstIntakeEnabled() {
  const raw = String(process.env.LLM_FIRST_INTAKE || "").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(raw);
}

function looksLikeBlueprintReply(text = "") {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  return (
    t.includes("here's the trip summary:") ||
    t.includes("trip summary") ||
    t.includes("should i generate the full itinerary now") ||
    /\bshould i generate the updated \d{1,2}-day itinerary now\??\s*$/i.test(String(text || "").trim()) ||
    t.includes("should i generate the itinerary now") ||
    (
      t.includes("should i generate this itinerary") &&
      t.includes("destination:") &&
      t.includes("duration:")
    )
  );
}

function assistantAskedExactGenerateItineraryCta(text = "") {
  return /(?:Should I generate (?:the full itinerary|the updated \d{1,2}-day itinerary) now\?|Want me to generate (?:the full itinerary|the updated \d{1,2}-day itinerary) from this\?|Shall I turn this into (?:the full itinerary|the updated \d{1,2}-day itinerary)\?|Ready for the itinerary draft based on this summary\?)\s*$/i.test(String(text || "").trim());
}

function userExplicitlyRequestsItineraryGeneration(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  return /\b(?:generate|genrate|geneate|generte|henerate|build|create|make)\b[\s\S]{0,60}\b(?:the\s+)?(?:full\s+)?itinerary\b/i.test(t) ||
    /\b(?:the\s+)?(?:full\s+)?itinerary\b[\s\S]{0,60}\b(?:generate|genrate|geneate|generte|henerate|build|create|make)\b/i.test(t);
}

function userAffirmsBlueprintGeneration(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (latestUserBypassesPendingBlueprintRevision(t)) return false;
  if (/\b(?:make sure|include|add|avoid|remove|skip|keep|not too many|don't include|do not include|last stop|every day|every night|nightlife|must[- ]?try|gardens?|church(?:es)?|cathedral|basilica|shrine|religious|food|beach|lagoon|museum|mall|market|park|waterfall|temple)\b/i.test(t)) {
    return false;
  }
  const explicitGeneration = userExplicitlyRequestsItineraryGeneration(t) ||
    /\b(?:generate|genrate|geneate|generte|henerate|build|create|make)\b[\s\S]{0,50}\b(?:it|this|that|plan|trip)\b/i.test(t) ||
    /\b(?:plan|trip)\b[\s\S]{0,50}\b(?:generate|genrate|geneate|generte|henerate|build|create|make)\b/i.test(t) ||
    /\b(?:go\s+ahead|do\s+it|proceed|continue)\b/i.test(t);
  const containsTripDetailWithoutGenerate =
    /\b(?:i\s*(?:'\s*ll|will)\s+stay|we'?ll\s+stay|stay\s+(?:in|at|near)|base\s+(?:is|in|at|near)|hotel\s*(?:is|\/base)|origin\s+(?:is|=)|from\s+[A-Za-z]|budget\s+(?:is|=)|date\s+(?:is|=)|start\s+(?:is|=))\b/i.test(t) &&
    !explicitGeneration;
  if (containsTripDetailWithoutGenerate) return false;
  if (explicitGeneration) return true;
  return /^(?:yes|yes please|sure|ok|okay|yep|yup|sige|please|now|go|continue|proceed|generate|genrate|geneate|generte|henerate|generate it|genrate it|geneate it|generte it|henerate it|build|build it|make it)$/i.test(t);
}

function buildConfirmedBlueprintDecision() {
  return {
    intent: "confirm_generate",
    tripContext: {
      destination: null,
      subArea: null,
      country: null,
      days: null,
      date: null,
      travelers: null,
      budget: null,
      theme: null,
      origin: null,
      startTime: null,
      transportMode: null,
      baseArea: null,
      noHotelYet: null,
      userAcceptsDefault: null,
      uncertainAbout: [],
      essentialsComplete: true
    },
    replyText: "Generating now...",
    pendingEdits: [],
    shouldGenerate: true
  };
}

function confirmedBlueprintFromRecent(recent = []) {
  let latestUserIndex = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex < 0 || !userAffirmsBlueprintGeneration(recent[latestUserIndex]?.content)) {
    return false;
  }

  const latestUser = String(recent[latestUserIndex]?.content || "");
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (recent[i]?.role === "assistant") {
      const assistantText = String(recent[i]?.content || "");
      if (assistantAskedExactGenerateItineraryCta(assistantText)) return true;
      return userExplicitlyRequestsItineraryGeneration(latestUser) && looksLikeBlueprintReply(assistantText);
    }
  }
  return false;
}

function userAffirmsAccommodationOffer(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  return /^(?:yes|yes please|sure|ok|okay|yep|go|go ahead|continue|proceed|show me|list them|recommend them|please do)$/i.test(t);
}

function previousAssistantOfferedAccommodationRecommendation(recent = []) {
  let latestUserIndex = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex <= 0 || !userAffirmsAccommodationOffer(recent[latestUserIndex]?.content)) return false;
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (recent[i]?.role !== "assistant") continue;
    const text = String(recent[i]?.content || "");
    const offeredStayGuidance =
      /\b(?:recommend|suggest|show|list|stays\/base areas to check|stay\/base recommendation|stays?\s+(?:in|near|around)|places?\s+to\s+stay)\b/i.test(text) ||
      /\b(?:live-search filters|property filters|room filters|booking filters|stay\/base guidance|stay\/base live-search filters)\b/i.test(text);
    const hasStayContext =
      /\b(?:hotel|hotels|hostel|hostels|accommodation|accomodation|accomadation|stay|place(?:s)? to stay|under\s+(?:₱|php|p)?\s*\d|resort|resorts|lodging|room|rooms|property|properties|booking|listings?)\b/i.test(text);
    return offeredStayGuidance && hasStayContext;
  }
  return false;
}

function accommodationRecommendationBaseFromRecent(recent = []) {
  let latestUserIndex = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (recent[i]?.role !== "assistant") continue;
    const text = String(recent[i]?.content || "");
    const match = text.match(/\b(?:recommended\s+)?(?:stays?|hotels?|accommodations?|lodging)\s+(?:near|in|around)\s+([^,\n.;:]{2,80})/i);
    const base = cleanTripFactValue(match?.[1] || "");
    if (base) return base;
  }
  return "";
}

function previousAssistantOfferedTripSummary(recent = []) {
  let latestUserIndex = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex <= 0 || !userAffirmsAccommodationOffer(recent[latestUserIndex]?.content)) return false;
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (recent[i]?.role !== "assistant") continue;
    const text = String(recent[i]?.content || "");
    return /\bWant me to build the trip summary now\?\s*$/i.test(text) ||
      /\bWant me to show the trip summary now\?\s*$/i.test(text);
  }
  return false;
}

function previousAssistantAccommodationShortlistChoiceText(recent = []) {
  let latestUserIndex = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex <= 0) return "";
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (recent[i]?.role !== "assistant") continue;
    const text = String(recent[i]?.content || "");
    const offeredShortlist =
      /\b(?:shortlist|which\s+base|what\s+base|base\s+should|area\s+should|would\s+you\s+like)\b/i.test(text) &&
      /\b(?:hotel|hotels|hostel|hostels|accommodation|accomodation|accomadation|stay|stays|place(?:s)?\s+to\s+stay|lodging|resort|resorts)\b/i.test(text) &&
      /\bor\b/i.test(text);
    return offeredShortlist ? text : "";
  }
  return "";
}

function accommodationShortlistBaseFromUser(text = "", assistantText = "") {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const ackless = raw
    .replace(/^\s*(?:yes|yeah|yep|yup|sure|ok|okay|sige|please)\b[\s,.;:-]*/i, "")
    .replace(/\b(?:based|base|shortlist|value|option|area|please)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const direct =
    canonicalBoholBaseAreaForIntake(ackless || raw) ||
    canonicalCamiguinBaseAreaForIntake(ackless || raw);
  if (direct) return direct;

  const assistant = String(assistantText || "");
  if (/^\s*1\s*$/i.test(raw)) {
    if (/\btagbilaran\b/i.test(assistant)) return "Tagbilaran City";
    if (/\bmambajao\b|\byumbing\b/i.test(assistant)) return "Mambajao / Yumbing";
  }
  if (/^\s*2\s*$/i.test(raw)) {
    if (/\bpanglao\b|\balona\b/i.test(assistant)) return "Panglao / Alona Beach area";
    if (/\bmahinog\b/i.test(assistant)) return "Mahinog";
  }
  return "";
}

async function buildAccommodationShortlistRefinementDecision(recent = []) {
  const assistantText = previousAssistantAccommodationShortlistChoiceText(recent);
  if (!assistantText) return null;
  const latestUser = getLatestUserText(recent);
  const selectedBase = accommodationShortlistBaseFromUser(latestUser, assistantText);
  if (!selectedBase) return null;

  const normalized = await normalizeTripContextForLatestUser(
    {
      intent: "answer_question",
      tripContext: createBlankTripContext(),
      replyText: "",
      pendingEdits: [],
      shouldGenerate: false,
    },
    recent
  );
  const tripContext = normalized.tripContext || {};
  tripContext.baseArea = selectedBase;
  tripContext.hotelArea = "";
  tripContext.selectedHotel = "";
  tripContext.noHotelYet = true;
  const priorRequest = latestAccommodationRequestText(recent.slice(0, -1));

  return {
    ...normalized,
    intent: "answer_question",
    shouldGenerate: false,
    pendingEdits: [],
    tripContext,
    replyText: buildAccommodationRecommendationSection(
      tripContext,
      [priorRequest, latestUser].filter(Boolean).join(" ")
    ),
  };
}

function previousUserRequestedAccommodationRecommendations(recent = []) {
  return recent
    .slice(0, -1)
    .some((turn) => turn?.role === "user" && latestUserRequestsAccommodationRecommendations(turn.content));
}

function tripSummaryAlreadyVisibleInRecent(recent = []) {
  return recent.some((turn) => turn?.role === "assistant" && looksLikeBlueprintReply(turn.content));
}

function shouldAppendBlueprintAfterAccommodationRecommendation(tripContext = {}, recent = [], latestUser = "") {
  if (tripSummaryAlreadyVisibleInRecent(recent)) return false;
  tripContext.essentialsComplete = recomputeTripEssentialsComplete(tripContext);
  const coreEssentialsKnown = Boolean(
    (tripContext.destination || tripContext.subArea) &&
    tripContext.days &&
    tripContext.date &&
    tripContext.travelers &&
    tripContext.budget &&
    tripContext.origin &&
    tripContext.startTime &&
    tripContext.transportMode &&
    (tripContext.baseArea || tripContext.noHotelYet === true)
  );
  console.log("[intake] auto-show gate", {
    coreEssentialsKnown,
    essentialsComplete: tripContext.essentialsComplete,
    fields: {
      destination: tripContext.destination || tripContext.subArea || null,
      days: tripContext.days || null,
      date: tripContext.date || null,
      travelers: tripContext.travelers || null,
      budget: tripContext.budget || null,
      origin: tripContext.origin || null,
      startTime: tripContext.startTime || null,
      transportMode: tripContext.transportMode || null,
      base: tripContext.baseArea || (tripContext.noHotelYet ? "noHotelYet" : null),
    },
  });

  return Boolean(tripContext?.essentialsComplete && coreEssentialsKnown);
}

function latestUserSaysDetailsAlreadyProvided(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return false;
  return /\b(?:i|we)\s+(?:already|alrdy)\s+(?:provided|gave|sent|told)\s+(?:you\s+)?(?:that|those|it|them|the\s+details?|the\s+info|everything)\b/i.test(raw) ||
    /\b(?:already|alrdy)\s+(?:provided|gave|sent|told)\s+(?:you\s+)?(?:that|those|it|them|the\s+details?|the\s+info|everything)\b/i.test(raw);
}

async function buildAlreadyProvidedDetailsDecision(recent = [], appContext = {}) {
  const latestUser = getLatestUserText(recent);
  if (!latestUserSaysDetailsAlreadyProvided(latestUser)) return null;

  const normalized = await normalizeTripContextForLatestUser(
    {
      intent: "update_context",
      tripContext: createBlankTripContext(),
      replyText: "",
      pendingEdits: [],
      shouldGenerate: false,
    },
    recent
  );
  const tripContext = normalized.tripContext || {};
  await prepareTripContextForEssentials(tripContext, appContext);
  if (tripContext.essentialsComplete) {
    return buildBlueprintOrMissingDecision({ ...normalized, tripContext }, recent, appContext, { pendingEdits: [] });
  }

  return {
    ...normalized,
    intent: "update_context",
    shouldGenerate: false,
    pendingEdits: [],
    tripContext,
    replyText: [
      "You're right — I'll use the details you've already provided.",
      "",
      await buildGroupedMissingFieldsQuestionWithProviders(tripContext, appContext),
    ].filter(Boolean).join("\n"),
  };
}

function previousAssistantAskedSetupQuestion(recent = []) {
  let latestUserIndex = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex <= 0) return false;
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (recent[i]?.role !== "assistant") continue;
    const text = String(recent[i]?.content || "");
    return /\b(?:Origin|Start time|Base stay|Hotel\/base|Budget|Travelers|Date\/month|Which part|Which .* base|Where are you starting|What time|Who(?:'|’)s coming|budget, mid-range, or luxury)\b/i.test(text);
  }
  return false;
}

async function buildComplaintOrMetaDecision(recent = []) {
  const latestUser = getLatestUserText(recent);
  const forceSummaryRecovery =
    /\b(?:cut\s+off|didn['’]?t\s+finish|did\s+not\s+finish|reply\s+was\s+incomplete)\b[\s\S]{0,120}\b(?:trip\s+summary|summary|details)\b/i.test(latestUser) ||
    /\b(?:where\s+(?:is|are)|where's)\b[\s\S]{0,50}\b(?:trip\s+summary|summary|details)\b/i.test(latestUser);
  if (!forceSummaryRecovery && !latestUserIsComplaintOrMeta(latestUser)) return null;

  const priorAccommodationRequest = previousUserRequestedAccommodationRecommendations(recent);
  const normalizationRecent = priorAccommodationRequest || forceSummaryRecovery ? recent.slice(0, -1) : recent;
  const normalized = await normalizeTripContextForLatestUser(
    {
      intent: "answer_question",
      tripContext: createBlankTripContext(),
      replyText: "",
      pendingEdits: [],
      shouldGenerate: false,
    },
    normalizationRecent
  );

  if (latestUserIsPositiveMetaAcknowledgement(latestUser)) {
    return {
      ...normalized,
      intent: "answer_question",
      shouldGenerate: false,
      pendingEdits: [],
      replyText: "Glad that version works better. I won't make any itinerary changes unless you ask for another update.",
    };
  }

  const correction = "You're right - that should not have been treated as an itinerary request, and I won't add that message to your trip preferences.";
  if (priorAccommodationRequest) {
    const priorRecent = recent.slice(0, -1);
    const priorText = priorRecent.map((turn) => String(turn?.content || "")).join(" ");
    if (
      !String(normalized.tripContext?.destination || normalized.tripContext?.subArea || "").trim() &&
      /\b(?:baguio|burnham\s+park|session\s+road)\b/i.test(priorText)
    ) {
      normalized.tripContext.destination = "Baguio";
      normalized.tripContext.country = "Philippines";
      normalized.tripContext.baseArea = normalized.tripContext.baseArea || "Session Road / Burnham Park / City Center";
      normalized.tripContext.noHotelYet = true;
      normalized.tripContext.hotelStatus = normalized.tripContext.hotelStatus || "needs_recommendation";
      normalized.tripContext.essentialsComplete = recomputeTripEssentialsComplete(normalized.tripContext);
    }
    const recommendation = buildAccommodationRecommendationSection(
      normalized.tripContext || {},
      latestAccommodationRequestText(priorRecent)
    );
    const sections = appendBlueprintIfSetupCompletedAfterRecommendation({
      normalizedParsed: normalized,
      recent: priorRecent,
      latestUser: latestAccommodationRequestText(priorRecent),
      sections: [recommendation],
    });
    if (latestUserRequestsTripSummary(latestUser) && !sections.some((section) => looksLikeBlueprintReply(section))) {
      sections.push(buildCanonicalIntakeBlueprintReply({ ...normalized, pendingEdits: [] }, priorRecent));
    }
    return {
      ...normalized,
      intent: sections.some((section) => looksLikeBlueprintReply(section)) ? "show_blueprint" : "answer_question",
      shouldGenerate: false,
      pendingEdits: [],
      replyText: sections.filter(Boolean).join("\n\n---\n\n"),
    };
  }

  return {
    ...normalized,
    intent: "answer_question",
    shouldGenerate: false,
    pendingEdits: [],
    replyText: correction,
  };
}

function getLatestUserText(recent = []) {
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]?.role === "user") return String(recent[i]?.content || "").trim();
  }
  return "";
}

function latestAccommodationRequestText(recent = []) {
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]?.role !== "user") continue;
    const text = String(recent[i]?.content || "");
    if (latestUserRequestsAccommodationRecommendations(text)) return text;
  }
  return getLatestUserText(recent);
}

function latestUserRequestsAccommodationRecommendations(text = "") {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  const asksRecommendation = /\b(recommend|suggest|list|show|find|where\s+to\s+stay|place\s+to\s+stay|places\s+to\s+stay)\b/i.test(t);
  const asksBudgetStay =
    /\b(?:cozy|cosy|cheap|cheapest|budget|affordable|low[-\s]?cost)\b[\s\S]{0,50}\b(?:stay|stays|hotel|hotels|hostel|hostels|room|rooms|place\s+to\s+stay|places\s+to\s+stay|accommodation|lodging)\b/i.test(t) ||
    /\b(?:stay|stays|hotel|hotels|hostel|hostels|room|rooms|place\s+to\s+stay|places\s+to\s+stay|accommodation|lodging)\b[\s\S]{0,50}\b(?:cozy|cosy|cheap|cheapest|budget|affordable|low[-\s]?cost)\b/i.test(t);
  const asksBaseRecommendation = /\b(?:recommend|suggest|pick|choose|find|where)\b[\s\S]{0,40}\b(?:base|hotel\s*\/\s*base|base\s+area)\b/i.test(t) ||
    /\b(?:base|hotel\s*\/\s*base|base\s+area)\b[\s\S]{0,40}\b(?:recommend|suggest|pick|choose|find)\b/i.test(t);
  const hasAccommodationCap = /\b(?:under|below|less\s+than|max(?:imum)?|up\s+to)\s*(?:₱|php|p)?\s*\d+(?:[,.]\d+)?\s*(?:k|thousand)?\s*(?:per\s*night|pernight|\/night|nightly|a\s+night)?\b/i.test(t);
  // "accomodation" (single-m) and "accomadation" are extremely common typos.
  // Match them as the same intent as the correctly-spelled word.
  const accommodationContext =
    /\b(hotel|hotels|hostel|hostels|accommodation|accommodations|accomodation|accomodations|accomadation|accomadations|stay|stays|place\s+to\s+stay|places\s+to\s+stay|guesthouse|guesthouses|inn|inns|room|rooms|lodging|lodgings|resort|resorts|base|base\s+area)\b/i.test(t) ||
    hasAccommodationCap;
  const explicitItineraryConstraint =
    !asksRecommendation &&
    /\b(?:include|add|make\s+sure|keep|use|set|hotel\s+budget|accommodation\s+budget|stay\s+under|base\s+under|place\s+to\s+stay\s+under|lodging\s+under)\b/i.test(t);
  return (asksBaseRecommendation && accommodationContext) ||
    (asksRecommendation && accommodationContext) ||
    (asksBudgetStay && accommodationContext) ||
    (hasAccommodationCap && accommodationContext && !explicitItineraryConstraint);
}

function latestUserRequestsTripSummary(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (userExplicitlyRequestsItineraryGeneration(raw)) return false;
  return /\b(?:provide|show|display|give|send|see|view|review)\b[\s\S]{0,50}\b(?:trip\s+summary|summary|trip\s+card|details)\b/i.test(raw) ||
    /\b(?:where\s+(?:is|are)|where's)\b[\s\S]{0,50}\b(?:trip\s+summary|summary|trip\s+card|details)\b/i.test(raw) ||
    /\b(?:trip\s+summary|summary|trip\s+card)\b[\s\S]{0,50}\b(?:please|now|again|provide|show|display|give|send|see|view|review|where)\b/i.test(raw);
}

function latestUserProvidesSetupDetail(text = "") {
  return /\b(?:\d{1,2}\s*[- ]?\s*days?|from\s+[A-Za-z]|origin\b|starting\s+from|coming\s+from|morning|afternoon|evening|night|am\b|pm\b|with\s+(?:family|friends|partner|kids)|solo|family|friends|mid[-\s]?range|budget|luxury|base|hotel|place\s+to\s+stay|stay\s+in|stay\s+at|recommend\s+me\s+a\s+base|recommend\s+a\s+base|public\s+transport|public\s+transit|jeepney|tricycle|habal[\s-]?habal|private\s+car|bus|van|ferry|flight|grab|taxi|train|subway|metro|shuttle)\b/i.test(String(text || ""));
}

function latestUserRequestsDirectAnswerOnly(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (latestUserIsComplaintOrMeta(raw)) return true;
  if (latestUserAsksFallbackItineraryGeneration(raw)) return false;
  if (/\b(?:generate|build|create|make|plan)\b[\s\S]{0,80}\bitinerary\b/i.test(raw)) return false;
  if (/\bitinerary\b[\s\S]{0,80}\b(?:generate|build|create|make|plan|edit|update|change|add|remove|include)\b/i.test(raw)) return false;
  if (latestUserRequestsAccommodationRecommendations(raw)) return true;

  const asksRecommendation = /\b(?:recommend|suggest|list|show|find|where\s+(?:to|can|should)|what\s+(?:place|places|food|restaurant|cafe|hotel|stay|area))\b/i.test(raw);
  const travelTopic = /\b(?:food|foods|restaurant|restaurants|cafe|cafes|coffee|place|places|spot|spots|attraction|attractions|things\s+to\s+do|activity|activities|hotel|stay|stays|lodging|base|budget|cost|price|under|below|less\s+than|cheap|affordable)\b/i.test(raw);
  if (asksRecommendation && travelTopic) return true;

  return /\b(?:how\s+much|cost|price|budget|expenses?|estimate|afford|under|below|less\s+than|max(?:imum)?|up\s+to)\b/i.test(raw) &&
    /\b(?:trip|travel|hotel|stay|room|night|food|restaurant|transport|ferry|flight|tour|activity|place)\b/i.test(raw);
}

function textHasAccommodationBudgetContext(text = "") {
  return /\b(?:per\s+night|\/night|nightly|hotel|hotels|hostel|hostels|place\s+to\s+stay|places\s+to\s+stay|accommodation|accommodations|accomodation|accomodations|accomadation|accomadations|room|rooms|guesthouse|guesthouses|inn|inns|lodging|lodgings|resort|resorts)\b/i.test(
    String(text || "")
  );
}

function normalizeIntakeBudgetTierToken(value = "") {
  const token = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!token) return "";
  if (/^mid\s*-?\s*rang(?:e|ed)?$|^midrang(?:e|ed)?$/.test(token)) return "Mid-range";
  if (/^luxury$/.test(token)) return "Luxury";
  if (/^budget$/.test(token)) return "Budget";
  return "";
}

function extractDelimitedTripBudgetTier(text = "") {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";

  const exact = normalizeIntakeBudgetTierToken(raw);
  if (exact) return exact;

  const labeled = raw.match(/\b(?:trip\s+budget|travel\s+budget|budget)\s*(?:is|=|:)\s*(budget|mid\s*-?\s*rang(?:e|ed)?|midrang(?:e|ed)?|luxury)\b/i);
  if (labeled) return normalizeIntakeBudgetTierToken(labeled[1]);

  const delimited = raw.match(
    /(?:^|[,;\n]|\band\b|\bor\b)\s*(budget|mid\s*-?\s*rang(?:e|ed)?|midrang(?:e|ed)?|luxury)\s*(?=$|[,;.!?\n]|\band\b|\bor\b|\s+(?:from|with|on|in|to|our|my|we|i|flight|departure|depart|leave|leaving|bus|car|van|ferry|partner|family|friends|solo)\b)/i
  );
  return normalizeIntakeBudgetTierToken(delimited?.[1] || "");
}

function userMessageHasExplicitTripBudget(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (/\b(?:no|not|without|don'?t\s+have|dont\s+have)\s+(?:a\s+)?(?:fixed\s+)?budget\b/i.test(raw)) {
    return false;
  }
  if (extractDelimitedTripBudgetTier(raw)) return true;
  if (textHasAccommodationBudgetContext(raw) && !/\b(?:trip|travel|itinerary|overall|total|all[-\s]?in|per\s+(?:person|pax|head)|each|pp)\b/i.test(raw)) {
    return false;
  }
  if (/\b(?:mid\s*-?\s*rang(?:e|ed)?|midrang(?:e|ed)?|luxury)\b/i.test(raw)) return true;
  if (/\b(?:budget[-\s]?friendly|budget\s+(?:trip|travel|option|plan)|on\s+(?:a\s+)?budget|tight\s+budget|cheap|affordable|tipid)\b/i.test(raw)) {
    return true;
  }
  if (extractRecentTripBudgetTier([{ role: "user", content: raw }])) return true;
  return false;
}

function previousAssistantAskedBudgetQuestion(recent = []) {
  let latestUserIndex = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex < 0) return false;

  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    if (turn?.role !== "assistant") continue;
    const text = String(turn.content || "");
    return /-\s+\*\*Budget:\*\*|\bBudget,\s*mid\s*-?\s*range,\s*or\s*luxury\?/i.test(text);
  }
  return false;
}

function latestUserAcceptsBudgetDefault(recent = []) {
  if (!previousAssistantAskedBudgetQuestion(recent)) return false;
  const latestUser = getLatestUserText(recent);
  return /\b(?:you\s+choose|your\s+choice|no\s+preference|no\s+idea|i\s+don'?t\s+know|i\s+dont\s+know|default|anything|any|whatever|up\s+to\s+you)\b/i.test(
    latestUser
  );
}

function recentUserProvidedOrAcceptedTripBudget(recent = []) {
  if (latestUserAcceptsBudgetDefault(recent)) return true;
  return recent.some((turn) => turn?.role === "user" && userMessageHasExplicitTripBudget(turn.content));
}

function latestUserRequestsTripReset(text = "") {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  // Broad reset phrasing the user may use. Each clause is a stand-alone
  // signal — matching any one of them is a reset, not an edit.
  return (
    /\b(?:clear everything|start over|start fresh|fresh trip|completely new trip|new trip:|generate from scratch|from scratch)\b/i.test(raw) ||
    /\b(?:forget (?:the )?(?:previous|old|earlier|prior) (?:conversation|trip|itinerary|chat|context))\b/i.test(raw) ||
    /\b(?:forget (?:cebu|manila|bohol|baguio|panglao|tagbilaran|el\s*nido|boracay|davao|palawan|coron|baler|tagaytay|siargao|siquijor|camiguin))\b/i.test(raw) ||
    /\b(?:ignore (?:the )?(?:previous|prior) (?:itinerary|trip|conversation|plan))\b/i.test(raw) ||
    /\b(?:reset (?:this )?(?:trip|itinerary|conversation|plan))\b/i.test(raw) ||
    /\b(?:stop\.?\s+(?:clear|start|forget|reset))\b/i.test(raw) ||
    /\b(?:let me try again)\b/i.test(raw) ||
    /\b(?:new destination\s*:\s*[A-Za-z])/i.test(raw) ||
    /\b(?:switch to (?:cebu|manila|bohol|baguio|panglao|tagbilaran|el\s*nido|boracay|davao|palawan|coron|baler|tagaytay|siargao|siquijor|camiguin)\b)/i.test(raw)
  );
}

function latestUserLooksLikeTripCorrection(text = "") {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  if (extractIntakeDurationCorrectionDays(raw)) return true;
  return /\b(?:messed up|wrong|incorrect|not listening|fix it|regenerate the summary|correct(?:ion)?|i already said|i said|i didn['’]?t say|i did not say|i meant|no,?\s*i meant|replace\b|wait\s*[—-]|instead)\b/i.test(raw) ||
    /\b(?:destination|origin|travelers?|style|theme|budget|duration|date|start(?:\s*time)?|transport|hotel\/base|base)\s+(?:is|are|should be|=)\b/i.test(raw);
}

function latestUserSaysResponseIsConfusing(text = "") {
  return /\b(?:confusing|too many questions|too much|unclear|simplify|make it simple|simple please)\b/i.test(String(text || ""));
}

function latestUserAsksFallbackItineraryGeneration(text = "") {
  const t = String(text || "").trim();
  if (!/\bfallback\b/i.test(t)) return false;
  return /\b(?:generate|regenerate|build|create|make|redo|rebuild)\b[\s\S]{0,80}\bitinerary\b/i.test(t) ||
    /\bitinerary\b[\s\S]{0,80}\b(?:generate|regenerate|build|create|make|redo|rebuild)\b/i.test(t);
}

function latestUserIsPositiveMetaAcknowledgement(text = "") {
  return /^\s*(?:that\s+(?:is|was|'s)\s+better|this\s+(?:is|was|'s)\s+better|looks\s+better|better\s+now|that\s+works|ok(?:ay)?\s+better|good\s+now)\s*[.!?]*\s*$/i.test(
    String(text || "")
  );
}

function latestUserIsComplaintOrMeta(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (latestUserAsksFallbackItineraryGeneration(raw)) return false;
  if (
    latestUserRequestsTripSummary(raw) &&
    !/\b(?:cut\s+off|didn['’]?t\s+finish|did\s+not\s+finish|reply\s+was\s+incomplete|where\s+is|where's)\b/i.test(raw)
  ) {
    return false;
  }
  if (/\b(?:food|foods|local\s+food|famous\s+food|nightlife|bars?|drinks?|church(?:es)?|cathedral|basilica|shrine|camp\s+sawi|strawberry\s+farm)\b[\s\S]{0,80}\b(?:add|include|put|itinerary|trip|plan)\b/i.test(raw)) return false;
  if (latestUserIsPositiveMetaAcknowledgement(raw)) return true;
  return (
    /\b(?:i\s+didn['’]?t\s+ask|i\s+did\s+not\s+ask|didn['’]?t\s+ask\s+for|did\s+not\s+ask\s+for|why\s+did\s+you|why\s+are\s+you|why\s+do\s+you|you\s+added|you\s+put|add(?:ed)?\s+(?:that|it)|you\s+cut\s+off|cut\s+off\s+the\s+conversation|you\s+didn['’]?t\s+finish|you\s+did\s+not\s+finish|your\s+reply\s+was\s+incomplete|you\s+didn['’]?t\s+answer|you\s+did\s+not\s+answer|trip\s+summary|special\s+requests?|that\s+(?:is|was|'s)\s+fallback|fallback[-\s]?style|don['’]?t\s+use\s+fallback|do\s+not\s+use\s+fallback|not\s+(?:an?\s+)?itinerary|unwanted\s+itinerary)\b/i.test(raw) ||
    /^\s*(?:no|nah|nope),?\s*(?:i\s+)?(?:didn'?t|did\s+not)\s+ask\b/i.test(raw)
  );
}

function looksLikeAmbiguousManiguinIslandRequest(text = "") {
  const raw = String(text || "");
  return /\bmaniguin\b/i.test(raw) && /\b(?:island|trip|itinerary|travel|visit|go|plan)\b/i.test(raw);
}

function normalizeIntakeDestinationTypos(text = "") {
  return compactIntakeText(text)
    .replace(/\bcaniguin\b/gi, "Camiguin")
    .replace(/\bcamuguin\b/gi, "Camiguin")
    .replace(/\bcamigin\b/gi, "Camiguin")
    .replace(/\bmanadaue\b/gi, "Mandaue")
    .replace(/\btagbilaaran\b/gi, "Tagbilaran");
}

function looksLikeClearCamiguinTypo(text = "") {
  return /\b(?:caniguin|camuguin|camigin)\b/i.test(String(text || ""));
}

function assistantAskedAmbiguousIslandClarification(text = "") {
  const raw = String(text || "");
  return /\bdid you mean\b/i.test(raw) &&
    /\bcamiguin\b/i.test(raw) &&
    /\bmanjuyod\b/i.test(raw) &&
    /\banother island\b/i.test(raw);
}

function previousAssistantAskedAmbiguousIslandClarification(recent = []) {
  const latestUserIndex = (() => {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (recent[i]?.role === "user") return i;
    }
    return -1;
  })();
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (recent[i]?.role !== "assistant") continue;
    return assistantAskedAmbiguousIslandClarification(recent[i]?.content);
  }
  return false;
}

function extractDestinationFromAmbiguousIslandConfirmation(text = "", previousAssistantText = "") {
  if (!assistantAskedAmbiguousIslandClarification(previousAssistantText)) return "";
  if (/\bcamiguin\b/i.test(String(text || ""))) return "Camiguin";
  if (/\bmanjuyod\b/i.test(String(text || ""))) return "Manjuyod";
  return "";
}

function extractCorrectedDestinationFromComplaint(text = "") {
  const raw = String(text || "");
  if (!/\b(?:wrong|incorrect|not right|asked about|ask about|reply about|replied about|recommend(?:ed)?|destination|should(?:\s+stay|\s+be)?)\b/i.test(raw)) {
    return "";
  }
  const normalized = normalizeIntakeDestinationTypos(raw);
  if (/\bsanta\s+fe\b|\bsta\.?\s*fe\b/i.test(normalized) && /\b(?:destination|should|only|bantayan|cebu)\b/i.test(normalized)) {
    return "Santa Fe";
  }
  if (/\bbantayan\b/i.test(normalized) && /\b(?:destination|should|only|cebu)\b/i.test(normalized)) return "Bantayan Island";
  if (/\bcamiguin\b/i.test(normalized) && /\bbohol\b/i.test(normalized)) return "Camiguin";
  if (/\bcamiguin\b/i.test(normalized)) return "Camiguin";
  if (/\bbohol\b/i.test(raw) && /\bcebu\b/i.test(raw)) return "Bohol";
  return "";
}

function latestUserStartsFreshDestinationContext(text = "") {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  if (looksLikeAmbiguousManiguinIslandRequest(raw)) return true;
  if (looksLikeClearCamiguinTypo(raw)) return true;
  if (extractCorrectedDestinationFromComplaint(raw)) return true;
  const travelVerbWithDuration =
    /\b(?:i|we)\s+(?:want|wanna|would\s+like|plan|are\s+planning|planning)\s+to\s+(?:go|travel|head|visit)\s+(?:to\s+)?[\p{L}\p{M}][\p{L}\p{M} .'’-]{1,60}?\s+(?:for\s+)?\d{1,2}\s*[- ]?\s*(?:days?|nights?)\b/iu.test(raw);
  const planNounWithDestination =
    /\b(?:provide|give|make|create|build|plan)\s+(?:me|us)?\s*(?:an?\s+)?(?:\d{1,2}\s*[- ]?\s*day\s+)?(?:trip|itinerary|plan)\s+(?:to|in|for)\s+[\p{L}\p{M}][\p{L}\p{M} .'’-]{1,60}\b/iu.test(raw);
  return /\b(?:now\s+)?(?:plan|make|create|build|give\s+me)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:\d{1,2}\s*[- ]?\s*day\s+)?(?:trip|itinerary)\s+(?:to|in|for)\b/i.test(raw) ||
    /\b(?:new destination|different destination|switch(?:ing)?\s+to|how about)\b/i.test(raw) ||
    travelVerbWithDuration ||
    planNounWithDestination;
}

function latestUserBypassesPendingBlueprintRevision(text = "") {
  return latestUserIsComplaintOrMeta(text) || latestUserRequestsTripReset(text) || latestUserStartsFreshDestinationContext(text) || latestUserLooksLikeTripCorrection(text);
}

function createBlankTripContext() {
  return {
    destination: null,
    subArea: null,
    country: null,
    days: null,
    date: null,
    travelers: null,
    budget: null,
    theme: null,
    origin: null,
    startTime: null,
    preTripTravel: null,
    overnightBase: null,
    itineraryStartDate: null,
    itineraryStartTime: null,
    itineraryStartPoint: null,
    transportMode: null,
    baseArea: null,
    accommodationBudget: null,
    hotelStatus: null,
    hotelArea: null,
    selectedHotel: null,
    noHotelYet: null,
    breakfastIncluded: false,
    breakfastNote: "",
    specialRequests: [],
    userAcceptsDefault: null,
    uncertainAbout: [],
    essentialsComplete: false,
  };
}

function compactIntakeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanTripFactValue(value = "") {
  return compactIntakeText(value)
    .replace(/^['"“”]+|['"“”]+$/g, "")
    .replace(/[.?!]+$/g, "")
    .trim();
}

const CROSS_FIELD_CLAUSE_RX =
  /\b(?:morning|afternoon|evening|night|early|late|budget|mid[\s-]?range|luxury|cheap|suggest|recommend|recommendation|place\s+to\s+stay|stay\s+under|stays?|hotel|accommodation|under\s+(?:\d|p|php|peso)|food|nightlife)\b/i;

function containsCrossFieldClauseLeak(value = "") {
  return CROSS_FIELD_CLAUSE_RX.test(String(value || ""));
}

const EXPLICIT_TRANSPORT_MODE_RX =
  /\b(public\s+transport|public\s+transit|jeepney|tricycle|habal[\s-]?habal|bus|van|ferry|flight|private\s+car|grab|taxi|train|subway|metro|shuttle)\b/i;

const BASE_AREA_STOP_LOOKAHEAD = String.raw`(?=\s*(?:[,.;!?]|$)|\s+\b(?:also|and|plus|under|below|max(?:imum)?|up\s+to|no\s+more\s+than|public\s+transport|public\s+transit|jeepney|tricycle|habal[\s-]?habal|bus|van|ferry|flight|private\s+car|grab|taxi|train|subway|metro|shuttle)\b)`;

const BASE_AREA_STATEMENT_RXES = [
  new RegExp(String.raw`\b(?:stay(?:ing)?|hotel|base|sleep|book(?:ing)?)\s+(?:at|in|near|around)\s+([\p{L}][\p{L}\p{M}'’.\- ]{1,40}?)${BASE_AREA_STOP_LOOKAHEAD}`, "iu"),
  new RegExp(String.raw`\bi\s*(?:'ll|’ll|will)\s+stay\s+(?:in|at|near|around)\s+([\p{L}][\p{L}\p{M}'’.\- ]{1,40}?)${BASE_AREA_STOP_LOOKAHEAD}`, "iu"),
  new RegExp(String.raw`\b(?:my\s+)?base\s+(?:is|will\s+be|should\s+be)\s+(?:in|at|near|around)?\s*([\p{L}][\p{L}\p{M}'’.\- ]{1,40}?)${BASE_AREA_STOP_LOOKAHEAD}`, "iu"),
  new RegExp(String.raw`\b(?:i\s*(?:'ll|’ll|will)\s+be\s+(?:at|in|near)|stay(?:ing)?\s+(?:at|in|near)|base\s+(?:at|in|near)|hotel\s+(?:at|in|near)|sleep\s+(?:at|in|near))\s+([\p{L}][\p{L}\p{M}'’.\- ]{1,40}?)${BASE_AREA_STOP_LOOKAHEAD}`, "iu"),
];

function normalizeExplicitTransportMode(value = "") {
  const raw = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!raw) return "";
  if (/^public\s+(?:transport|transit)$/.test(raw)) return "public transport";
  if (/^private\s+car$/.test(raw)) return "private car";
  if (/^habal/.test(raw)) return "habal-habal";
  if (raw === "flight") return "flight + local transfer";
  if (raw === "ferry") return "ferry + local transfer";
  return raw;
}

function extractExplicitTransportModeFromText(text = "") {
  const match = String(text || "").match(EXPLICIT_TRANSPORT_MODE_RX);
  return normalizeExplicitTransportMode(match?.[1] || "");
}

function cleanBaseAreaCandidate(value = "") {
  return cleanTripFactValue(value)
    .replace(/\s+\b(?:under|below|max(?:imum)?|up\s+to|no\s+more\s+than)\b[\s\S]*$/i, "")
    .replace(/\s+\b(?:public\s+transport|public\s+transit|jeepney|tricycle|habal[\s-]?habal|bus|van|ferry|flight|private\s+car|grab|taxi|train|subway|metro|shuttle)\b[\s\S]*$/i, "")
    .replace(/\s+\b(?:also|and|plus)\b[\s\S]*$/i, "")
    .replace(/^[,;:\s]+|[,;:\s]+$/g, "")
    .trim();
}

function extractBaseStatementParts(text = "") {
  const source = String(text || "");
  for (const rx of BASE_AREA_STATEMENT_RXES) {
    const match = source.match(rx);
    const candidate = cleanBaseAreaCandidate(match?.[1] || "");
    if (!match || !candidate || invalidIntakeBaseArea(candidate)) continue;
    const before = source.slice(0, match.index);
    const after = source.slice(match.index + match[0].length);
    const rest = `${before} ${after}`
      .replace(/^\s*(?:[,.;]\s*)?(?:also|and|plus)\s+/i, "")
      .replace(/\s+(?:[,.;]\s*)?(?:also|and|plus)\s+/i, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return { candidate, rest };
  }
  return null;
}

function textHasAccommodationContext(text = "") {
  return /\b(?:hotel|hotels|hostel|hostels|stay|stays|base|base\s+area|place\s+to\s+stay|places\s+to\s+stay|accommodation|accommodations|accomodation|accomodations|lodging|room|rooms|guesthouse|guesthouses|inn|inns|resort|resorts)\b/i.test(
    String(text || "")
  );
}

async function validateBaseAreaCandidateForTrip(candidate = "", tripContext = {}) {
  const clean = cleanBaseAreaCandidate(candidate);
  if (!clean || invalidIntakeBaseArea(clean)) return "";
  const canonical = canonicalKnownBaseAreaForIntake(clean);
  const explicitShortBase = /\b(?:santa\s+fe|sta\.?\s*fe)\b/i.test(clean)
    ? "Santa Fe"
    : /\bsession\s+road\b/i.test(clean)
    ? "Session Road"
    : "";
  if (explicitShortBase) return explicitShortBase;
  const destination = formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext);
  if (!destination || destination === "the destination") return canonical || titleCaseIntakeValue(clean);

  const destinationCountry = String(tripContext?.country || "").trim();
  try {
    const [baseGeo, destGeo] = await Promise.all([
      typeof geocodeArea === "function"
        ? geocodeArea([clean, destination, destinationCountry].filter(Boolean).join(", "), { providerTimeoutMs: 8000 })
        : null,
      typeof geocodeArea === "function"
        ? geocodeArea(destination, { providerTimeoutMs: 8000 })
        : null,
    ]);
    const sameCountry =
      !baseGeo?.countryCode ||
      !destGeo?.countryCode ||
      String(baseGeo.countryCode).toLowerCase() === String(destGeo.countryCode).toLowerCase();
    const distanceKm = distanceKmBetween(baseGeo, destGeo);
    const destinationKey = normalizeIntakePlace(destination);
    const formattedKey = normalizeIntakePlace(baseGeo?.formatted || "");
    const destinationTokens = destinationKey.split(/\s+/).filter((token) => token.length >= 4);
    const appearsInsideDestination = destinationTokens.some((token) => formattedKey.includes(token));
    if (baseGeo?.name && sameCountry && (appearsInsideDestination || distanceKm == null || distanceKm <= 160)) {
      return canonical || titleCaseIntakeValue(clean);
    }
  } catch (error) {
    console.warn("[intake] base-area free geocoder validation failed", { err: String(error?.message || error || "") });
  }

  try {
    const placeSearch = typeof searchPlaceCandidates === "function"
      ? await searchPlaceCandidates(`${clean} ${destination}`, {
          maxResultCount: 3,
          providerTimeoutMs: 8000,
        })
      : null;
    const cleanKey = normalizeIntakePlace(clean);
    const destinationKey = normalizeIntakePlace(destination);
    const accepted = (placeSearch?.results || []).some((place) => {
      const haystack = normalizeIntakePlace([place?.name, place?.address, place?.city, place?.country].filter(Boolean).join(" "));
      return haystack.includes(cleanKey) && (
        !destinationKey ||
        destinationKey.split(/\s+/).filter((token) => token.length >= 4).some((token) => haystack.includes(token))
      );
    });
    if (accepted) return canonical || titleCaseIntakeValue(clean);
  } catch (error) {
    console.warn("[intake] base-area place search validation failed", { err: String(error?.message || error || "") });
  }

  return canonical || "";
}

const INTAKE_DAY_WORD_TO_NUM = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseIntakeDayNumberToken(value = "") {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return null;
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n >= 1 && n <= 60 ? n : null;
  }
  return INTAKE_DAY_WORD_TO_NUM[token] || null;
}

function extractIntakeDurationCorrectionDays(text = "") {
  const source = compactIntakeText(text).toLowerCase();
  if (!source) return null;
  const num = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)";
  const patterns = [
    new RegExp(`\\binstead\\s+of\\s+${num}\\s*(?:day|days|night|nights)?[\\s\\S]{0,90}?\\b(?:can\\s+you\\s+)?(?:make|change|update|set|turn)\\s+(?:it|this|the\\s+trip|the\\s+duration)?\\s*(?:to|into)?\\s*${num}\\s*(?:day|days|night|nights)?\\b`, "i"),
    new RegExp(`\\b(?:can\\s+you\\s+)?(?:make|change|update|set|turn)\\s+(?:it|this|the\\s+trip|the\\s+duration)?\\s*(?:to|into)?\\s*${num}\\s*(?:day|days|night|nights)?\\b`, "i"),
    new RegExp(`\\b(?:duration|trip\\s+duration|days?)\\s+(?:should\\s+be|is|are|=|to)\\s*${num}\\s*(?:day|days|night|nights)?\\b`, "i"),
    new RegExp(`\\bactually\\s+${num}\\s*(?:day|days|night|nights)?\\b`, "i"),
    new RegExp(`\\bshorter\\s+(?:to|into)\\s+${num}\\s*(?:day|days|night|nights)?\\b`, "i"),
  ];
  for (const rx of patterns) {
    const m = source.match(rx);
    if (!m) continue;
    const parsed = parseIntakeDayNumberToken(m[m.length - 1]);
    if (parsed) return parsed;
  }
  return null;
}

function extractBreakfastPreferenceFromText(text = "") {
  const source = compactIntakeText(text);
  if (!source) return null;
  if (/\b(?:no|skip|without|do\s+not|don't|dont)\s+(?:include\s+)?(?:breakfast|brunch|morning meal)\b/i.test(source)) {
    return { breakfastIncluded: false, breakfastNote: "not included unless requested" };
  }
  if (!/\b(?:breakfast|brunch|morning meal)\b/i.test(source)) return null;
  const arrival = /\b(?:arriv(?:e|ed|ing|al)|after\s+(?:i|we)?\s*arriv|upon\s+arrival|when\s+(?:i|we)?\s*arriv)\b/i.test(source);
  return {
    breakfastIncluded: true,
    breakfastNote: arrival ? "arrival breakfast/brunch included" : "included",
  };
}

function stripSpecialRequestImperatives(text = "") {
  return compactIntakeText(text)
    .replace(/\b(?:please\s+)?(?:add|include|put)\s+(?:it|them|this|that|those|these)?\s*(?:to|on|in|into)?\s*(?:the\s+)?(?:itinerary|trip|plan|summary)?\s*$/i, "")
    .replace(/\s+(?:to\s+(?:visit|see|try|stop\s+by)|during\s+the\s+trip|on\s+the\s+trip)\s*$/i, "")
    .replace(/\b(?:on|in|to)\s+(?:the\s+)?(?:itinerary|trip|plan)\s*$/i, "")
    .replace(/^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:also\s+)?(?:add|include|put)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpecialRequestText(text = "") {
  const original = compactIntakeText(text);
  if (!original) return "";
  const raw = stripSpecialRequestImperatives(original);
  if (!raw || /^(?:it|them|this|that|those|these)$/i.test(raw)) return "";
  if (latestUserIsComplaintOrMeta(raw)) return "";
  if (/\b(?:breakfast|brunch|morning meal)\b/i.test(raw)) return "";
  // The user asking us to recommend a stay is a recommendation REQUEST, not
  // a special request to print on the trip summary. Previously this got
  // captured as "Special requests: recommend a place for 3 days".
  if (/\brecommend\s+(?:me\s+)?(?:a\s+)?(?:place|stay|hotel|hostel|inn|resort|accommodation|accomodation)\b/i.test(raw)) {
    return "";
  }
  // Worldwide guard: any accommodation-intent phrase or lodging-named
  // candidate is an accommodation request, not a special itinerary request.
  if (typeof isAccommodationIntentPhrase === "function" && isAccommodationIntentPhrase(raw)) {
    return "";
  }
  if (/\b(?:hotel|hostel|resort|inn|guesthouse|guest\s*house|lodge|villa|cabin|rental|rentals|homestay|airbnb|lodging|accommodation|accomodation|place\s+to\s+stay|places\s+to\s+stay|where\s+to\s+stay|room|rooms)\b/i.test(raw) &&
    !/\b(?:tour|sunset|sunrise|view|viewpoint|deck|hopping|day\s+tour|temple|museum|park|beach|island|falls?|waterfall|spring|cave|market|landmark)\b/i.test(raw)) {
    return "";
  }
  if (/\b(?:strawberry\s+(?:garden|farm|picking)|la\s+trinidad)\b/i.test(raw)) {
    return "La Trinidad Strawberry Farm";
  }
  if (/\bgardens?\b.*\bchurch(?:es)?\b|\bchurch(?:es)?\b.*\bgardens?\b/i.test(raw)) {
    return "gardens and churches";
  }
  if (/\b(?:food|foods|local\s+food|famous\s+food|must[-\s]?try|eat|dining)\b/i.test(raw) && /\b(?:nightlife|bars?|drinks?|evening)\b/i.test(raw)) {
    return "famous local food, light nightlife";
  }
  if (/\b(?:food|foods|local\s+food|famous\s+food|must[-\s]?try|eat|dining)\b/i.test(raw) && /\bchurch(?:es)?|cathedral|basilica|parish|shrine\b/i.test(raw)) {
    return "famous local food, churches";
  }
  if (/\b(?:food|foods|local\s+food|famous\s+food|must[-\s]?try|eat|dining)\b/i.test(raw)) {
    return "famous local food";
  }
  if (/\b(?:nightlife|bars?|drinks?|evening)\b/i.test(raw)) {
    return "light nightlife";
  }
  if (/\bchurch(?:es)?|cathedral|basilica|parish|shrine\b/i.test(raw)) {
    return "churches";
  }
  if (/\bfood\b.*\bhistory\b|\bhistory\b.*\bfood\b/i.test(raw)) {
    return "food and history";
  }

  let cleaned = raw
    .replace(/^\s*(?:and|but|also|then)\b[\s,.;:!-]*/i, "")
    .replace(/^\s*(?:before\s+you\s+generate|before\s+generating|make\s+sure(?:\s+to)?|please|can\s+you|could\s+you)\b[\s,.;:!-]*/i, "")
    .replace(/^\s*(?:include|add|keep|avoid|remove|skip)\b[\s,.;:!-]*/i, "")
    .replace(/^\s*(?:i\s+want\s+to\s+visit|i\s+want|we\s+like|we\s+want|i\s+like)\b[\s,.;:!-]*/i, "")
    .replace(/\bcan\s+you\s+add\s+that\b/ig, "")
    .replace(/\b(?:please|thanks?)\b/ig, "")
    .replace(/\s+/g, " ")
    .replace(/[.?!]+$/g, "")
    .trim();
  if (!cleaned) return "";
  // Word-boundary truncation so labels like "Katibawasan Falls" don't lose
  // "Falls" to a hard mid-character cut. The cap is generous (200 chars) so
  // a multi-clause request like "...staying in an overwater bungalow, and
  // relaxing on the pristine 'Bikini Beaches' of local islands like
  // Maafushi" is never sliced mid-name (the old cap of 110 cut "Maafushi"
  // → "Ma"). When the source IS over the cap, only break at major
  // separators (comma / semicolon / " and ") so we don't drop a single
  // trailing place name.
  if (cleaned.length > 200) {
    const window = cleaned.slice(0, 200);
    const lastBreak = Math.max(
      window.lastIndexOf(", "),
      window.lastIndexOf("; "),
      window.lastIndexOf(" and "),
    );
    cleaned = `${(lastBreak > 80 ? window.slice(0, lastBreak) : window).trim()}…`;
  }
  return cleaned;
}

function shouldResolveProviderMustVisits(text = "") {
  return /\b(?:special requests?|must[-\s]?visits?|include|add|keep|put|visit|see|explore|tour|stop(?:s)? at|go to|before (?:you )?generate)\b/i.test(String(text || ""));
}

function normalizeProviderCandidateKey(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAccommodationIntentPhrase(value = "") {
  const t = String(value || "").toLowerCase();
  if (!t) return false;
  if (/\b(?:recommend|suggest|find|pick|choose|propose|need|want|looking\s+for|where\s+to)\b[\s\S]{0,40}\b(?:place\s+to\s+stay|places\s+to\s+stay|stay|hotel|hotels|hostel|hostels|accommodation|accomodation|lodging|guesthouse|guest\s*house|inn|resort|villa|cabin|rental|rentals|homestay|lodge|airbnb|booking|room|rooms)\b/i.test(t)) return true;
  if (/\b(?:where\s+to\s+stay|place\s+to\s+stay|places\s+to\s+stay|somewhere\s+to\s+stay|find\s+a\s+stay|find\s+stay|find\s+(?:a\s+)?(?:hotel|hostel|resort|guesthouse|inn|villa|cabin|lodge|accommodation|accomodation))\b/i.test(t)) return true;
  if (/\b(?:hotel|hostel|resort|guesthouse|inn|villa|cabin|lodge|accommodation|accomodation|airbnb|booking|stay)\s+(?:recommendation|recommendations|suggestion|suggestions|options?)\b/i.test(t)) return true;
  if (/\b(?:under|below|less\s+than|max(?:imum)?|up\s+to|no\s+more\s+than)\s+[\d,.kK₱$€£\s]+(?:\/?night|per\s+night|a\s+night|nightly|stay)\b/i.test(t)) return true;
  return false;
}

function cleanProviderPlaceCandidate(value = "") {
  let candidate = cleanTripFactValue(value)
    .replace(/^\s*(?:the|a|an)\s+/i, "")
    .replace(/^\s*(?:visit|see|explore|tour|go\s+to|add|include|keep|put|stop\s+at)\s+/i, "")
    .replace(/\s+(?:please|pls|too|also|during\s+the\s+trip)$/i, "")
    .replace(/[.?!;:,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!candidate || candidate.length < 3 || candidate.length > 80) return "";
  const key = normalizeProviderCandidateKey(candidate);
  if (!key) return "";
  if (/^(?:and|or|there|this|that|it|them|places?|spots?|activities?|goods?|churches?|temples?|museums?|parks?|markets?|restaurants?|cafes?|food|nightlife|shopping|family|friends?|solo|budget|origin|hotel|base|days?|trip|itinerary|destination)$/.test(key)) return "";
  if (/\b(?:travelers?|budget|origin|from|flight|hotel|base|duration|days?|nights?|generate|itinerary|trip|include|visit|with|start|date)\b/i.test(candidate)) return "";
  // Accommodation intent must never become an itinerary must-visit. Caller
  // routes these to the accommodation flow instead.
  if (isAccommodationIntentPhrase(candidate)) return "";
  if (/^\s*(?:recommend|suggest|find|need|want|looking\s+for)\b/i.test(candidate)) return "";
  if (/\b(?:hotel|hostel|resort|inn|suite|guest\s*house|guesthouse|lodge|villa|cabin|rental|rentals|homestay|airbnb|accommodation|accomodation|lodging|place\s+to\s+stay|places\s+to\s+stay|where\s+to\s+stay|room|rooms)\b/i.test(candidate)) return "";
  // Worldwide-safe: pure single-word "island" / "province" / "region" /
  // "city" are area types, not itinerary stops. Combined with the
  // destination ("Camiguin Island") it would become a redundant
  // destination-as-stop entry — the validator already enforces a single
  // destination, so we drop these early.
  if (/^(?:island|islands|province|region|state|county|prefecture|city|town|municipality|district|barangay|area|country)$/i.test(candidate)) return "";
  // Worldwide-safe: route-area direction words ("south", "north", "south
  // cebu", "north cebu", "northern", "southern", "eastern", "western")
  // and itinerary-planning instructions ("remaining days", "the rest",
  // "the other days") are NEVER provider place names. A user saying
  // "focus cebu city on day 1 and visit south and north on remaining
  // days" must not turn "south" into "South Restaurant & Jazz Club".
  if (/^(?:north|south|east|west|northern|southern|eastern|western|northeast|northwest|southeast|southwest|ne|nw|se|sw|uphill|downhill|inland|coastal|mountain[-\s]?side|sea[-\s]?side)(?:\s+(?:cebu|side|area|region|part|portion|route|cluster|coast))?$/i.test(candidate)) return "";
  if (/^(?:remaining\s+days?|the\s+rest|other\s+days?|next\s+days?|last\s+days?|second\s+day|third\s+day|final\s+day|day\s+\d+|days?\s+\d+\s*(?:-|–|to)\s*\d+|morning|afternoon|evening|night|noon|midnight)$/i.test(candidate)) return "";
  return titleCaseIntakeValue(candidate);
}

function splitProviderCandidateList(value = "") {
  return String(value || "")
    .split(/\s*,\s*|\s*;\s*|\s+\bor\b\s+|\s+\band\b\s+/i)
    .map(cleanProviderPlaceCandidate)
    .filter(Boolean);
}

function stripAccommodationIntentClauses(text = "") {
  // Cuts off accommodation-intent sub-clauses ("recommend me a place to stay
  // near X", "find a hotel under 2k", etc.) before the must-visit extractor
  // ever sees them. Otherwise the provider lookup turns a stay request into
  // a fake itinerary stop named after a random rental listing.
  return String(text || "")
    .replace(/(?:^|[,;.]|\band\b|\balso\b|\bplus\b)\s*(?:please\s+)?(?:and\s+)?(?:can\s+you\s+|could\s+you\s+|pls\s+|please\s+)?(?:recommend|suggest|find|pick|choose|propose|need|want|looking\s+for|where\s+to)\s+(?:me\s+|us\s+)?(?:a\s+|an\s+|some\s+|the\s+)?(?:good\s+|nice\s+|cheap\s+|budget\s+|cozy\s+|cosy\s+|affordable\s+|low[-\s]?cost\s+|mid[-\s]?range\s+|luxury\s+|high[-\s]?end\s+|premium\s+)?(?:place\s+to\s+stay|places\s+to\s+stay|stay|hotel|hotels|hostel|hostels|accommodation|accomodation|lodging|guesthouse|guest\s*house|inn|resort|villa|cabin|rental|rentals|homestay|lodge|airbnb|room|rooms|base)[\s\S]*?(?=(?:[.!?]|$|\bbut\b|\bhowever\b))/gi, " ")
    .replace(/(?:^|[,;.]|\band\b|\balso\b|\bplus\b)\s*(?:where\s+to\s+stay|place\s+to\s+stay|places\s+to\s+stay|somewhere\s+to\s+stay)[\s\S]*?(?=(?:[.!?]|$))/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractProviderPlaceCandidatesFromText(text = "") {
  const source = stripAccommodationIntentClauses(normalizeIntakeDestinationTypos(text));
  if (!source || !shouldResolveProviderMustVisits(source)) return [];
  const candidates = [];
  candidates.push(...extractListedMustVisitsFromText(source));

  const requestMatches = source.matchAll(/\b(?:special requests?|must[-\s]?visits?|include|add|keep|put|visit|see|explore|tour|stop(?:s)? at|go to)\s*:?\s+(.+?)(?=$|[.!?]|\b(?:also\s+include|before|after|then|while|my\s+trip|with\s+(?:friends|family|partner|parents)|from\s+\p{L}|start(?:ing)?\s+|mid\s*range|budget|luxury|for\s+\d+\s+days?)\b)/giu);
  for (const match of requestMatches) {
    candidates.push(...splitProviderCandidateList(match[1] || ""));
  }

  const landmarkNouns = "museum|temple|shrine|cathedral|basilica|church|mosque|synagogue|monument|memorial|tower|palace|castle|fort|ruins|park|garden|market|falls?|waterfalls?|spring|springs|cave|beach|island|river|lake|forest|sanctuary|zoo|aquarium|gallery";
  const landmarkRx = new RegExp(`\\b(?:the\\s+)?([\\p{L}\\p{M}'’.-]+(?:\\s+[\\p{L}\\p{M}'’.-]+){0,5}\\s+(?:${landmarkNouns}))\\b`, "giu");
  for (const match of source.matchAll(landmarkRx)) {
    candidates.push(cleanProviderPlaceCandidate(match[1] || ""));
  }

  const properRx = /\b(?:the\s+)?([\p{Lu}\p{Lo}][\p{L}\p{M}'’.-]*(?:\s+[\p{Lu}\p{Lo}][\p{L}\p{M}'’.-]*){0,5})\b/gu;
  for (const match of source.matchAll(properRx)) {
    candidates.push(cleanProviderPlaceCandidate(match[1] || ""));
  }

  return uniqueIntakeLabels(candidates);
}

function providerPlaceHasUsableIdentity(place = {}) {
  const name = String(place?.name || place?.displayName?.text || "").trim();
  const location = place?.location || {};
  const lat = Number(location.lat ?? place.lat ?? place.latitude);
  const lng = Number(location.lng ?? location.lon ?? place.lng ?? place.longitude);
  return Boolean(name && Number.isFinite(lat) && Number.isFinite(lng));
}

function providerResultName(place = {}) {
  return cleanTripFactValue(place?.name || place?.displayName?.text || "");
}

const SPECIAL_REQUEST_RESOLUTION_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "at", "to", "for", "near",
  "around", "visit", "see", "go", "add", "include", "put", "stop", "by",
  "please", "also", "too", "want", "wanna", "would", "like",
]);

function specialRequestResolutionTokens(value = "") {
  return normalizeIntakePlace(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !SPECIAL_REQUEST_RESOLUTION_STOPWORDS.has(token));
}

function providerNameMatchesRequestedPlace(requested = "", providerName = "") {
  const requestedTokens = specialRequestResolutionTokens(requested);
  if (!requestedTokens.length) return true;
  const providerTokens = new Set(specialRequestResolutionTokens(providerName));
  if (!providerTokens.size) return false;
  const matched = requestedTokens.filter((token) => providerTokens.has(token));
  const needed = requestedTokens.length <= 2 ? requestedTokens.length : 2;
  return matched.length >= needed;
}

// Worldwide-safe filter for provider results that are administrative areas,
// government offices, regions, or corporate entities — not real itinerary
// stops. These have been polluting Special requests (e.g. "DepEd Sdo Cebu
// Province", "Fusion Cx - Cebu Philippines", "Cebu Province") when a place search
// lookup of a generic phrase like "food stops" returned admin/business
// entries instead of tourist attractions.
const ADMIN_OR_AGENCY_NAME_RX =
  /\b(?:province|prefecture|region|regional|state|county|district|barangay|municipality|municipal|city\s+hall|town\s+hall|capitol|department|ministry|bureau|office\s+(?:of|for)|deped|sdo|doh|dti|dswd|dpwh|dot\s+(?:office|regional)|tesda|dotr|nbi|sss|pagibig|philhealth|comelec|government|consulate|embassy|chamber\s+of\s+commerce|chamber\s+of|inc\.?(?:\b|$)|incorporated|llc(?:\b|$)|ltd\.?(?:\b|$)|limited(?:\b|$)|corp\.?(?:\b|$)|corporation|company|holdings?|enterprises?|services?\s+inc|srl|gmbh|co\.\s*ltd|cx\s*-|cx\b)\b/i;

function providerResultLooksLikeAdminOrAgency(place = {}, phrase = "") {
  const name = String(place?.name || place?.displayName?.text || "").trim();
  if (!name) return true;
  if (ADMIN_OR_AGENCY_NAME_RX.test(name)) return true;
  // If the name is just <destination> or <destination> Province / Region etc.,
  // it's an area pin, not a stop. Compare against the phrase or destination
  // hint loosely.
  const cleanName = name.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  const phraseTokens = String(phrase || "").toLowerCase().match(/[a-z]+/g) || [];
  if (cleanName.split(/\s+/).filter(Boolean).length <= 4 &&
      /\b(?:province|region|state|county|prefecture|district)\b/.test(cleanName) &&
      phraseTokens.some((token) => token.length >= 4 && cleanName.includes(token))) {
    return true;
  }
  const categoryText = [
    place?.primaryType,
    place?.category,
    Array.isArray(place?.types) ? place.types.join(" ") : "",
    Array.isArray(place?.categories) ? place.categories.map((c) => c?.name || c).join(" ") : "",
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\b(?:administrative_area|political|government_office|local_government_office|country|locality|sublocality|postal_code|administrative)\b/.test(categoryText)) {
    return true;
  }
  return false;
}

function pickProviderResultForSpecialRequest(results = [], phrase = "") {
  for (const place of Array.isArray(results) ? results : []) {
    if (!providerPlaceHasUsableIdentity(place)) continue;
    const name = providerResultName(place);
    if (!name) continue;
    if (providerResultLooksLikeAdminOrAgency(place, phrase)) {
      console.log(`[special-requests] resolved "${phrase.toLowerCase()}" → "${name}" REJECTED admin_or_agency`);
      continue;
    }
    if (providerNameMatchesRequestedPlace(phrase, name)) {
      console.log(`[special-requests] resolved "${phrase.toLowerCase()}" → "${name}"`);
      return name;
    }
    console.log(`[special-requests] resolved "${phrase.toLowerCase()}" → "${name}" REJECTED token_mismatch`);
  }
  return "";
}

const GENERIC_SPECIAL_REQUEST_THEME_RX =
  /\b(?:churches|church|temples|temple|shrines|shrine|museums|museum|beaches|beach|parks|park|gardens|garden|markets|market|malls|mall|shopping|food spots|food|sushi|wagyu|ramen|street food|nightlife|night[-\s]life|bars|bar|pubs?|clubs?|drinks?|party|live music|cafes|cafes|cafe|coffee|hiking|diving|snorkeling|surfing|surf|photography|heritage|historical)\b/gi;

function normalizeGenericThemeSpecialRequest(value = "") {
  const raw = compactIntakeText(value).toLowerCase();
  if (!raw) return "";
  const exact = raw
    .replace(/^\s*(?:and|or|also|then)\s+/i, "")
    .replace(/[.?!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!exact) return "";
  // Canonicalize common spelling variants before regex matching so "night
  // life" / "night-life" → "nightlife" / "light nightlife". Also strip
  // generic-noun suffixes ("places", "spots", "stops", "sites", "areas")
  // so phrases like "historical places" / "food spots" / "church stops"
  // normalize to the theme word alone instead of being dropped as
  // unresolved and shipped to a noisy provider search.
  const canonicalized = exact
    .replace(/\bnight[-\s]+life\b/gi, "nightlife")
    .replace(/\bsurfing\b/gi, "surfing")
    .replace(/\bevening\s+drinks?\b/gi, "nightlife")
    .replace(/\s+(?:places?|spots?|stops?|sites?|areas?|attractions?|landmarks?|things?(?:\s+to\s+do)?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  GENERIC_SPECIAL_REQUEST_THEME_RX.lastIndex = 0;
  const matches = [...canonicalized.matchAll(GENERIC_SPECIAL_REQUEST_THEME_RX)]
    .map((match) => String(match[0] || "").toLowerCase().trim())
    .filter(Boolean);
  if (!(matches.length === 1 && matches[0] === canonicalized)) return "";
  // Promote bare "nightlife" / "bars" / "drinks" / "party" / "club" to the
  // canonical "light nightlife" label TravelMate uses across the app.
  if (/^(?:nightlife|bars?|pubs?|clubs?|drinks?|party|live music)$/i.test(canonicalized)) {
    return "light nightlife";
  }
  // Promote "historical" → "heritage" (TravelMate's canonical theme label
  // used by the style/blueprint pipeline). Without this, "historical
  // places" / "historical sites" stay as the bare regex match and
  // disagree with the style label downstream.
  if (/^historical$/i.test(canonicalized)) {
    return "heritage";
  }
  return canonicalized;
}

function extractGenericThemeSpecialRequestsFromText(text = "") {
  const source = compactIntakeText(text).toLowerCase();
  if (!source || !shouldResolveProviderMustVisits(source)) return [];
  const out = [];
  GENERIC_SPECIAL_REQUEST_THEME_RX.lastIndex = 0;
  for (const match of source.matchAll(GENERIC_SPECIAL_REQUEST_THEME_RX)) {
    const label = normalizeGenericThemeSpecialRequest(match[0] || "");
    if (label) out.push(label);
  }
  return uniqueExactSpecialRequestLabels(out);
}

function uniqueExactSpecialRequestLabels(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const generic = normalizeGenericThemeSpecialRequest(value);
    const label = generic || normalizeSpecialRequestText(value) || compactIntakeText(value);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

// Worldwide-safe verb-led activity detector. Verb-led phrases like "hiking
// majestic trails", "taking refreshing dips in natural pools", "exploring
// underwater history" are ACTIVITY DESCRIPTIONS, not place names. Turning
// them into required map stops causes the validator to fail forever because
// no real provider place is named that.
const ACTIVITY_VERB_LED_PREFIX_RX =
  /^(?:hiking|trekking|biking|cycling|kayaking|paddling|surfing|swimming|snorkeling|snorkelling|diving|scuba\s+diving|free[-\s]?diving|sailing|boating|fishing|camping|climbing|bouldering|rappelling|canyoneering|caving|spelunking|skiing|skating|sledding|island[-\s]?hopping|hopping|chasing|spotting|watching|taking|enjoying|doing|exploring|visiting|seeing|relaxing|chilling|hanging|trying|tasting|eating|drinking|sampling|shopping|browsing|touring|going|riding|driving|walking|jogging|running|getting|having|experiencing|stargazing|sunbathing|picnicking|partying)\b/i;

// Map verb-led activity phrases to a single concise theme keyword. This is
// what we store instead of the verbatim phrase, so the validator treats it
// as a theme (not a required map stop). Generic, worldwide-safe — no place
// names. The keyword on the right matches one of the strings already
// allowed by GENERIC_SPECIAL_REQUEST_THEME_RX or normalizeSpecialRequestText
// so it survives downstream sanitization.
const ACTIVITY_PHRASE_TO_THEME = [
  { rx: /\b(?:island[-\s]?hopping|hopping\s+(?:islands?|sandbars?|beaches?))\b/i, theme: "island hopping" },
  { rx: /\b(?:hiking|trekking|trail(?:s)?|climbing)\b/i, theme: "hiking" },
  { rx: /\b(?:snorkel(?:ing|ling)?|snorkelling)\b/i, theme: "snorkeling" },
  { rx: /\b(?:scuba|diving|free[-\s]?diving|underwater)\b/i, theme: "diving" },
  { rx: /\b(?:surf(?:ing)?|surf\s+lesson)\b/i, theme: "surfing" },
  { rx: /\b(?:kayak(?:ing)?|paddl(?:ing|e\s+board)|sup)\b/i, theme: "kayaking" },
  { rx: /\b(?:hot\s+springs?|cold\s+springs?|spring|natural\s+pools?|waterfalls?|falls)\b/i, theme: "hot springs and waterfalls" },
  { rx: /\b(?:beach(?:es)?|sandbars?|white\s+sand)\b/i, theme: "beaches" },
  { rx: /\b(?:stargazing|sunset\s+watching|sunrise\s+watching)\b/i, theme: "scenic views" },
  { rx: /\b(?:night[-\s]?life|bars?|pub|club|drinks?|evening\s+drinks?|party|live\s+music)\b/i, theme: "light nightlife" },
  { rx: /\b(?:street\s+food|food|cuisine|local\s+dish(?:es)?|eat(?:ing)?|dining|food\s+tour)\b/i, theme: "famous local food" },
  { rx: /\b(?:shopping|markets?|mall)\b/i, theme: "shopping" },
  { rx: /\b(?:church(?:es)?|cathedral|basilica|shrine|chapel|temple|pagoda|mosque|synagogue|monastery)\b/i, theme: "churches" },
  { rx: /\b(?:history|heritage|museum|ruins|fort|castle|palace|ancestral|colonial)\b/i, theme: "heritage" },
  { rx: /\b(?:photo(?:graphy)?|photo\s+spots?)\b/i, theme: "photography" },
];

function activityPhraseToTheme(phrase = "") {
  const raw = String(phrase || "").trim();
  if (!raw) return "";
  if (!ACTIVITY_VERB_LED_PREFIX_RX.test(raw)) return "";
  for (const { rx, theme } of ACTIVITY_PHRASE_TO_THEME) {
    if (rx.test(raw)) return theme;
  }
  return "";
}

async function resolveProviderMustVisitCandidate(candidate = "", options = {}) {
  if (parseSpecialRequestCorrection(candidate)) return "";
  const phrase = cleanProviderPlaceCandidate(candidate);
  if (!phrase) return "";

  // Verb-led activity phrases ("hiking majestic trails", "taking refreshing
  // dips in natural pools", "exploring underwater history") are not place
  // names. Convert them to a concise theme keyword and skip the provider
  // lookup entirely. Without this, the validator forces these descriptive
  // strings into required map stops and the itinerary never validates.
  const activityTheme = activityPhraseToTheme(phrase);
  if (activityTheme) {
    console.log(`[special-requests] resolved "${phrase.toLowerCase()}" → theme:"${activityTheme}"`);
    return activityTheme;
  }

  const destinationHint = [
    options.destination,
    options.tripContext?.subArea,
    options.tripContext?.destination,
    options.country,
    options.tripContext?.country,
  ].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
  const query = [phrase, destinationHint].filter(Boolean).join(" ").trim();

  try {
    const placeSearch = typeof searchPlaceCandidates === "function"
      ? await searchPlaceCandidates(query || phrase, {
          maxResultCount: Number(options.maxResultCount) > 0 ? options.maxResultCount : 3,
          providerTimeoutMs: Number(options.providerTimeoutMs) > 0 ? options.providerTimeoutMs : 8000,
        })
      : null;
    const placeSearchName = pickProviderResultForSpecialRequest(placeSearch?.results, phrase);
    if (placeSearchName) return placeSearchName;
  } catch (error) {
    console.warn("[intake] provider must-visit place search lookup failed", { err: String(error?.message || error || "") });
  }

  try {
    const fallbackPlaces = await searchTextPlaces(query || phrase, {
      maxResultCount: Number(options.maxResultCount) > 0 ? options.maxResultCount : 3,
      timeZone: options.timeZone || options.appContext?.timezone || "",
    });
    const fallbackName = pickProviderResultForSpecialRequest(fallbackPlaces, phrase);
    if (fallbackName) return fallbackName;
  } catch (error) {
    console.warn("[intake] provider must-visit fallback lookup failed", { err: String(error?.message || error || "") });
  }

  // Worldwide-safe last line: when ALL provider results were rejected, do
  // NOT fall back to the user's raw phrase. Returning the raw phrase makes
  // it a required map stop the validator hunts for and never finds, which
  // bricks itinerary generation. If we cannot resolve a real place, drop
  // the entry — the user's intent is still captured by the conversation/
  // generic-theme normalizer.
  console.log(`[special-requests] resolved "${phrase.toLowerCase()}" → DROPPED unresolved_no_provider_match`);
  return "";
}

async function extractKnownMustVisitsFromText(text = "", options = {}) {
  if (parseSpecialRequestCorrection(text)) return [];
  const candidates = extractProviderPlaceCandidatesFromText(text);
  const resolved = extractGenericThemeSpecialRequestsFromText(text);
  // If the original user phrase normalizes to a generic theme like
  // "famous local food" / "light nightlife" / "churches", THAT is the
  // user's intent — don't also run provider lookups for candidates derived
  // from the same phrase, which return random businesses/admin areas
  // (e.g. "Fusion Cx - Cebu Philippines", "DepEd Sdo Cebu Province",
  // "<Destination> Province"). Worldwide-safe: the generic-theme normalizer
  // is theme-keyword based, not location based.
  const phraseNormalizedToGenericTheme = (typeof normalizeSpecialRequestText === "function")
    ? normalizeSpecialRequestText(text)
    : "";
  const phraseIsGenericThemeOnly = Boolean(
    phraseNormalizedToGenericTheme &&
    /^(?:famous local food|famous local food, churches|famous local food, light nightlife|light nightlife|churches|food and history|gardens and churches|la trinidad strawberry farm)$/i.test(phraseNormalizedToGenericTheme)
  );
  if (phraseIsGenericThemeOnly) {
    return uniqueExactSpecialRequestLabels([phraseNormalizedToGenericTheme, ...resolved]);
  }
  if (!candidates.length) return uniqueExactSpecialRequestLabels(resolved);
  for (const candidate of candidates.slice(0, Number(options.maxCandidates) > 0 ? options.maxCandidates : 6)) {
    const generic = normalizeGenericThemeSpecialRequest(candidate);
    if (generic) {
      resolved.push(generic);
      continue;
    }
    // Also reject candidates that the normalizer would turn into a generic
    // theme — e.g. "food stops" → "famous local food". Don't burn a place search
    // call to "resolve" something that's already a clean theme label.
    const themeLabel = (typeof normalizeSpecialRequestText === "function")
      ? normalizeSpecialRequestText(candidate)
      : "";
    if (themeLabel && /^(?:famous local food|light nightlife|churches|food and history|gardens and churches)/i.test(themeLabel)) {
      resolved.push(themeLabel);
      continue;
    }
    const label = await resolveProviderMustVisitCandidate(candidate, options);
    if (label) resolved.push(label);
    else console.warn("[intake] unresolved user special request candidate", { candidate });
  }
  return uniqueExactSpecialRequestLabels(resolved);
}

function normalizeListedMustVisitLabel(value = "") {
  let label = cleanTripFactValue(value)
    .replace(/^\s*(?:the|a|an)\s+/i, "")
    .replace(/^\s*(?:visit|see|explore|tour|go\s+to|add|include|relax\s+at|chill\s+at)\s+/i, "")
    .replace(/^\s*(?:browse|shop\s+for|look\s+for)\s+(?:vintage\s+goods\s+)?(?:at|in)\s+/i, "")
    .replace(/^\s*(?:at|in|near)\s+/i, "")
    .replace(/\s+(?:please|pls|too|also)$/i, "")
    .replace(/[.?!;:,]+$/g, "")
    .trim();
  if (!label || label.length < 3) return "";
  if (/^(?:and|or|there|this|that|it|them|places?|spots?|activities?|goods?)$/i.test(label)) return "";
  if (/\b(?:travelers?|budget|origin|from|flight|hotel|base|duration|days?)\b/i.test(label)) return "";
  label = titleCaseIntakeValue(label);
  return label;
}

function extractListedMustVisitsFromText(text = "") {
  const source = normalizeIntakeDestinationTypos(text);
  if (!source) return [];
  const match =
    source.match(/\b(?:i|we)\s+(?:want|wanna|would\s+like|plan|are\s+planning)\s+to\s+(?:visit|see|explore|tour|browse)\s+(.+?)(?=$|[.!?]|\b(?:before|after|then|while)\b)/i) ||
    source.match(/\b(?:include|add|keep|put)\s+(.+?)(?=$|[.!?]|\b(?:before|after|then|while)\b)/i);
  const captured = String(match?.[1] || "").trim();
  if (!captured) return [];
  if (/\b(?:budget|origin|from|flight|hotel|base|duration|days?)\b/i.test(captured)) return [];
  const cleaned = captured
    .replace(/\b(?:during|on)\s+(?:the\s+)?trip\b.*$/i, "")
    .replace(/\b(?:for|on)\s+day\s+\d+\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return uniqueIntakeLabels(
    cleaned
      .split(/\s*,\s*|\s*;\s*|\s+\bor\b\s+|\s+\band\b\s+/i)
      .map(normalizeListedMustVisitLabel)
      .filter(Boolean)
  );
}

function looksLikeBaseOrLocationOnlyLabel(label = "") {
  const t = String(label || "").trim();
  if (!t) return false;
  // Strip surrounding punctuation/articles for matching.
  const stripped = t.replace(/^[\s,;:.\-—]+|[\s,;:.\-—]+$/g, "").trim();
  if (!stripped) return false;
  // "Base: <area>" / "Base area is X" / "I've got X as the base" / "Stay near X".
  if (/^(?:base|base\s*area|hotel|hotel\s*\/?\s*base|stay|accommodation|origin|starting\s+point|from)\s*[:=-]\s*\S+/i.test(stripped)) return true;
  if (/^(?:near|in|at|around)\s+[A-Z][\p{L}\p{M}'’.\- ]+$/u.test(stripped)) return true;
  if (/\bas\s+the\s+base\b|\bas\s+(?:our|my)\s+base\b/i.test(stripped)) return true;
  if (/\b(?:i'?ve|i\s+have|we'?ve|we\s+have)\s+got\b[\s\S]{0,30}\bbase\b/i.test(stripped)) return true;
  // Worldwide-safe: "I will stay in X" / "we will stay at X" / "I'll stay
  // near X" / "stay in X" / "staying at X" / "based at X" / "I want to
  // stay in X". These are accommodation-base statements — they belong in
  // the Base/Hotel field, never in Special requests.
  if (/^(?:i'?(?:ll|m)|we'?(?:ll|re)|i|we)\s+(?:will\s+|wanna\s+|want\s+to\s+)?stay(?:ing)?\s+(?:in|at|near|around)\s+\S+/i.test(stripped)) return true;
  if (/^stay(?:ing)?\s+(?:in|at|near|around)\s+\S+/i.test(stripped)) return true;
  if (/^based?\s+(?:in|at|near|around)\s+\S+/i.test(stripped)) return true;
  // Pure budget tier ("Budget", "Mid-range", "Luxury") leaking into the list.
  if (/^(?:budget|mid[-\s]?rang(?:e|ed)?|midrang(?:e|ed)?|luxury)$/i.test(stripped)) return true;
  // Pure transport mode leaking.
  if (/^(?:public\s+transport|public\s+transit|private\s+car|grab|taxi|jeepney|tricycle|habal[\s-]?habal|bus|van|ferry|flight|train|subway|metro|shuttle|local\s+transport(?:\s+only)?)$/i.test(stripped)) return true;
  // Pure traveler descriptor.
  if (/^(?:solo|couple|with\s+partner|with\s+family|with\s+friends|friends|family|partner|group)$/i.test(stripped)) return true;
  // Date-only strings (months/days).
  if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:[\s,-]+\d{2,4})?$/i.test(stripped)) return true;
  // Administrative areas, government offices, and corporate entities are not
  // valid special-request labels. Worldwide-safe regex — pure category words.
  if (typeof ADMIN_OR_AGENCY_NAME_RX !== "undefined" && ADMIN_OR_AGENCY_NAME_RX.test(stripped)) return true;
  return false;
}

// Collapse near-duplicate special-request labels so the list cannot bloat
// across turns. Worldwide-safe — pure string normalization, no place names.
// Examples that collapse to a single entry:
//   "Hiking Majestic Trails" + "Hiking" → "Hiking" (shorter wins for
//     activity-theme labels)
//   "Taking Refreshing Dips Natural Pools" + "Taking Refreshing Dips In
//     Natural Pools" → kept as one (token set is identical)
//   "White Island" + "Island" → kept separate (real place vs single noun);
//     the bare "Island" gets dropped earlier by looksLikeBaseOrLocationOnlyLabel.
function specialRequestSignatureTokens(label = "") {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^(?:the|and|for|with|near|around|into|onto|from|over|under|some|that|this|those|these|your|our|their)$/.test(t))
    .sort()
    .join(" ");
}

// Worldwide-safe sanity check: random LLM-injected entities like "Glencore",
// company names, or off-topic words that have no support in the user's
// conversation history should never appear in specialRequests. A label is
// suspicious when it contains a multi-word proper-noun chunk that doesn't
// appear (case-insensitively, allowing minor punctuation) in the user's
// recent messages and isn't one of the known generic theme keywords.
function specialRequestLabelHasUserSupport(label = "", userTextHaystack = "") {
  const raw = String(label || "").trim();
  if (!raw) return true;
  const haystack = String(userTextHaystack || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!haystack) return true; // Without user context we can't decide; let it through.
  const tokens = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4);
  if (!tokens.length) return true;
  // Generic theme keywords are always allowed.
  if (/^(?:famous\s+local\s+food|light\s+nightlife|food\s+and\s+history|churches|diving|snorkeling|hiking|biking|kayaking|surfing|sailing|beach(?:es)?|hot\s+springs?|waterfalls?|natural\s+pools?|gardens|heritage|history|markets?|shopping|photography|stargazing)$/i.test(raw)) {
    return true;
  }
  // Require at least one significant token to appear in the user's history.
  return tokens.some((token) => haystack.includes(token));
}

// Standalone scrub: drop specialRequests entries that have no support in
// the user's conversation history. Call AFTER the normal uniqueIntakeLabels
// pipeline so we don't have to change every call site. Safe to call with an
// empty messages list (no scrub happens, no false negatives).
function scrubUnsupportedSpecialRequests(tripContext = {}, messages = []) {
  if (!tripContext || typeof tripContext !== "object") return tripContext;
  const list = Array.isArray(tripContext.specialRequests) ? tripContext.specialRequests : [];
  if (!list.length) return tripContext;
  const userText = (Array.isArray(messages) ? messages : [])
    .filter((m) => m?.role === "user")
    .map((m) => String(m.content || ""))
    .join(" ");
  if (!userText.trim()) return tripContext;
  const kept = list.filter((label) => {
    if (!specialRequestLabelHasUserSupport(label, userText)) {
      console.warn("[intake] scrub dropped specialRequests label without user support:", label);
      return false;
    }
    return true;
  });
  if (kept.length !== list.length) {
    tripContext.specialRequests = kept;
  }
  return tripContext;
}

function uniqueIntakeLabels(values = []) {
  const out = [];
  const seen = new Set();
  const signatures = new Map(); // signature → index in out
  for (const value of values) {
    if (latestUserIsComplaintOrMeta(value)) continue;
    const label = normalizeSpecialRequestText(value) || compactIntakeText(value);
    if (!label) continue;
    // Reject "None" / "N/A" / "—" placeholders so a stale "None" from a
    // prior blueprint cannot get merged with real entries and ship as
    // "Special requests: None, White Island, ...".
    if (/^(?:none|n\/a|na|—|-|nothing|no\s+special\s+requests?)$/i.test(label.trim())) continue;
    // Reject base/origin/budget/transport/traveler/date fragments that leaked
    // into specialRequests from a malformed summary line — these belong in
    // their own trip-state fields, not in the requested-activities list.
    if (looksLikeBaseOrLocationOnlyLabel(label)) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;

    // Near-duplicate collapse: if a prior entry has the same token signature
    // (same significant words, regardless of word order or filler), keep the
    // SHORTER, cleaner label. This stops a list from bloating into
    // "Hiking Majestic Trails, Hiking" or "Taking Refreshing Dips Natural
    // Pools, Taking Refreshing Dips in Natural Pools" across turns.
    const signature = specialRequestSignatureTokens(label);
    if (signature && signatures.has(signature)) {
      const existingIndex = signatures.get(signature);
      const existing = out[existingIndex];
      if (label.length < existing.length) {
        out[existingIndex] = label;
      }
      continue;
    }
    // Also collapse when one label's tokens are a strict subset of another:
    // keep the shorter (e.g. "Hiking Majestic Trails" + "Hiking" → "Hiking").
    let mergedIntoExisting = false;
    const labelTokens = new Set(signature.split(" ").filter(Boolean));
    for (const [otherSig, otherIndex] of signatures) {
      const otherTokens = new Set(otherSig.split(" ").filter(Boolean));
      const aSubB = [...labelTokens].every((t) => otherTokens.has(t));
      const bSubA = [...otherTokens].every((t) => labelTokens.has(t));
      if (aSubB && labelTokens.size > 0 && otherTokens.size > 0) {
        // Existing is a superset of the new; keep the new shorter label.
        if (label.length < out[otherIndex].length) out[otherIndex] = label;
        signatures.delete(otherSig);
        signatures.set(signature, otherIndex);
        mergedIntoExisting = true;
        break;
      }
      if (bSubA && labelTokens.size > 0 && otherTokens.size > 0) {
        // New is a superset of existing; existing already wins.
        mergedIntoExisting = true;
        break;
      }
    }
    if (mergedIntoExisting) {
      seen.add(key);
      continue;
    }

    seen.add(key);
    if (signature) signatures.set(signature, out.length);
    out.push(label);
  }
  return out;
}

function cleanSpecialRequestCorrectionValue(value = "") {
  return stripSpecialRequestImperatives(cleanTripFactValue(value))
    .replace(/^(?:that|this|it|them|those|these)\s+/i, "")
    .replace(/\b(?:please|pls|instead)\b.*$/i, "")
    .replace(/[.?!,;:]+$/g, "")
    .trim();
}

function parseSpecialRequestCorrection(text = "") {
  const raw = compactIntakeText(text);
  if (!raw) return null;
  let add = "";
  let remove = "";

  let match = raw.match(/\bi\s+said\s+(?:to\s+)?(?:add|include|visit|see)?\s*(.+?)\s+i\s+(?:didn['’]?t|did\s+not)\s+say\s+(.+)$/i);
  if (match) {
    add = match[1];
    remove = match[2];
  }

  if (!add && !remove) {
    match = raw.match(/\bno,?\s*i\s+meant\s+(.+?)\s+(?:not|instead\s+of)\s+(.+)$/i);
    if (match) {
      add = match[1];
      remove = match[2];
    }
  }

  if (!add && !remove) {
    match = raw.match(/\breplace\s+(.+?)\s+with\s+(.+)$/i);
    if (match) {
      remove = match[1];
      add = match[2];
    }
  }

  if (!remove) {
    match = raw.match(/\b(?:remove|delete|drop|skip)\s+(.+?)(?=$|[.?!,;])/i);
    if (match) remove = match[1];
  }

  if (!remove) {
    match = raw.match(/\bnot\s+(.+?)(?=$|[.?!,;])/i);
    if (match) remove = match[1];
  }

  add = cleanSpecialRequestCorrectionValue(add);
  remove = cleanSpecialRequestCorrectionValue(remove);
  if (!add && !remove) return null;
  return {
    add: add ? [add] : [],
    remove: remove ? [remove] : [],
  };
}

function specialRequestMatchesRemoval(existing = "", removal = "") {
  const existingKey = normalizeIntakePlace(existing);
  const removalKey = normalizeIntakePlace(removal);
  if (!existingKey || !removalKey) return false;
  if (existingKey === removalKey || existingKey.includes(removalKey) || removalKey.includes(existingKey)) return true;
  const removalTokens = specialRequestResolutionTokens(removal);
  if (!removalTokens.length) return false;
  const existingTokens = new Set(specialRequestResolutionTokens(existing));
  const needed = removalTokens.length <= 2 ? removalTokens.length : 2;
  return removalTokens.filter((token) => existingTokens.has(token)).length >= needed;
}

async function applySpecialRequestCorrectionToTripContext(tripContext = {}, text = "") {
  const correction = parseSpecialRequestCorrection(text);
  if (!correction) return tripContext;
  const existing = Array.isArray(tripContext.specialRequests) ? tripContext.specialRequests : [];
  let requests = existing.filter((entry) =>
    !correction.remove.some((remove) => specialRequestMatchesRemoval(entry, remove))
  );
  for (const add of correction.add) {
    const resolvedAdds = await extractKnownMustVisitsFromText(add, {
      tripContext,
      destination: [tripContext.subArea, tripContext.destination].filter(Boolean).join(" "),
      country: tripContext.country || "",
    });
    requests.push(...(resolvedAdds.length ? resolvedAdds : [add]));
  }
  tripContext.specialRequests = uniqueIntakeLabels(requests);
  return tripContext;
}

function extractCorrectedFieldValue(text = "", field = "") {
  const source = String(text || "");
  const aliases = {
    destination: "destination",
    origin: "origin",
    travelers: "travelers?|traveller|travellers",
    theme: "style|theme",
    budget: "budget",
    days: "duration|days?",
    date: "date|dates?",
    startTime: "start(?:\\s*time)?",
    transportMode: "transport(?:\\s*mode)?",
    baseArea: "hotel\\/base|base|hotel",
  };
  const label = aliases[field] || field;
  const rx = new RegExp(`\\b(?:${label})\\s+(?:is|are|should be|=)\\s*['"“”]?([^'",.\\n]+(?:\\s+[^'",.\\n]+){0,8})`, "i");
  const match = source.match(rx);
  const captured = cleanTripFactValue(match?.[1] || "");
  const guardField = /^(?:destination|origin|baseArea|transportMode)$/i.test(field);
  return guardField && captured && containsCrossFieldClauseLeak(captured) ? "" : captured;
}

const INTAKE_DESTINATION_PHRASE_SRC = String.raw`([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}'’.-]+){0,4})`;

function cleanProviderDestinationPhrase(value = "") {
  let cleaned = cleanTripFactValue(value)
    .replace(/\s+(?:instead|please|pls|now)$/i, "")
    .replace(/\s+(?:for|with|from|on|starting|start(?:ing)?|leave|leaving|depart|budget|friends?|family|solo)\b[\s\S]*$/i, "")
    .replace(/\s+(?:i|we|you|u|they|i'?m|i'?d|we'?re|let'?s|wanna|want|wants|wanted|need|needs|like|likes|liked|prefer|prefers|visit|visiting|see|seeing|explore|exploring|tour|touring|head|heading|go|going|do|does|did|yes|no|sure|okay|ok|maybe|please|pls|thanks)\b[\s\S]*$/i, "")
    .replace(/\s+\d+\s*[- ]?\s*(?:day|days|night|nights)\b.*$/i, "")
    .replace(/\s+(?:trip|itinerary|plan|tour|vacation|getaway)\s*$/i, "")
    .replace(/[?.!,;:]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 80) return "";
  // Worldwide collapse: "<theme phrase> in/at/near <City>" → just <City>.
  // Without this, "religious places in cebu" survives as the destination
  // and the LLM-based intake then re-parses "plan a" as a sibling
  // destination candidate.
  const cityTail = cleaned.match(/\b(?:in|at|near|around)\s+([\p{L}][\p{L}\p{M}'’.\- ]{1,40}?)\s*$/iu);
  if (cityTail?.[1]) cleaned = cityTail[1].trim();
  if (cleaned.split(/\s+/).length > 4) return "";
  if (/\b(?:hotel|hostel|resort|inn|suite|stay|stays|accommodation|guest\s*house|guesthouse|lodge)\b/i.test(cleaned)) return "";
  if (/^(?:me|us|a|an|the|trip|itinerary|plan|tour|vacation|getaway|please|now|instead|yes|no|sure|okay|ok)$/i.test(cleaned)) return "";
  // Reject verb / verb+article fragments like "plan a", "make the", "find me
  // a place". Worldwide-safe — pure English verbs, no city names.
  if (/^(?:plan|planning|make|making|create|creating|build|building|draft|drafting|generate|generating|find|finding|give|giving|show|showing|want|wanting|need|needing|have|having|get|getting|do|doing|help|helping|let|tell|telling|book|booking|map|recommend|recommending|suggest|suggesting)(?:\s+(?:me|us|a|an|the|some|any))?\s*$/i.test(cleaned)) return "";
  // Reject "<verb> me/us/a/an/the <single short token>" fragments — e.g.
  // "plan a" alone, "give me a", "show us the".
  if (/^(?:plan|make|create|build|draft|generate|find|give|show|want|need|have|get|do|book|map|recommend|suggest)\s+(?:me|us|a|an|the|some|any)\s+\S+$/i.test(cleaned) && cleaned.replace(/[^A-Za-z]/g, "").length <= 6) return "";
  // Reject generic theme/category nouns standing alone or with no real
  // place attached.
  if (/^(?:religious|famous|tourist|popular|beautiful|nature|food|nightlife|shopping|beach|beaches|church|churches|temple|temples|spot|spots|place|places|attraction|attractions|sight|sights|landmark|landmarks|site|sites|area|areas)(?:\s+(?:place|places|spot|spots|attraction|attractions|sight|sights|landmark|landmarks|site|sites|area|areas|tour|tours|trip|trips|itinerary|itineraries|food|foods|nightlife|shopping))?$/i.test(cleaned)) return "";
  return cleaned;
}

function extractProviderDestinationPhrase(text = "") {
  const source = normalizeIntakeDestinationTypos(text);
  if (!source) return "";
  const duration = String.raw`(?:\d+\s*[- ]?\s*(?:day|days|night|nights)|weekend|half[- ]day|full[- ]day)`;
  const patterns = [
    new RegExp(String.raw`\b(?:make|create|plan|build|draft|generate)\s+(?:me\s+|us\s+)?(?:an?\s+)?${duration}\s+(?:trip|itinerary|travel plan|plan|tour|vacation|getaway)\s+(?:in|to|for|around|at|near)\s+${INTAKE_DESTINATION_PHRASE_SRC}\b`, "iu"),
    new RegExp(String.raw`\b(?:make|create|plan|build|draft|generate)\s+(?:me\s+|us\s+)?(?:an?\s+)?(?:trip|itinerary|travel plan|plan|tour|vacation|getaway)\s+(?:in|to|for|around|at|near)\s+${INTAKE_DESTINATION_PHRASE_SRC}\b`, "iu"),
    new RegExp(String.raw`\b(?:make|create|plan|build|draft|generate)\s+(?:me\s+|us\s+)?(?:an?\s+)?${duration}\s+${INTAKE_DESTINATION_PHRASE_SRC}\s+(?:trip|itinerary|travel plan|plan|tour|vacation|getaway)\b`, "iu"),
    new RegExp(String.raw`\b(?:i|we)\s+(?:want|wanna|would\s+like|plan|are\s+planning|planning)\s+to\s+(?:go|travel|head)\s+to\s+${INTAKE_DESTINATION_PHRASE_SRC}\b`, "iu"),
    new RegExp(String.raw`\b(?:go|visit|travel|head|switch|move|change)\s+(?:over\s+)?to\s+${INTAKE_DESTINATION_PHRASE_SRC}\b`, "iu"),
    new RegExp(String.raw`\b(?:trip|itinerary|travel plan|plan|tour|vacation|getaway)\s+(?:in|to|for|around|at|near)\s+${INTAKE_DESTINATION_PHRASE_SRC}\b`, "iu"),
    new RegExp(String.raw`\b${duration}\s+(?:in|to|for|around|at|near)\s+${INTAKE_DESTINATION_PHRASE_SRC}\s+(?:trip|itinerary|travel plan|plan|tour|vacation|getaway)\b`, "iu"),
    new RegExp(String.raw`^(?!\s*(?:plan|planning|create|creating|make|making|build|building|draft|drafting|generate|generating|want|need|give|show|help|can|could|please|hey|hi|hello|i|we|let|lets|let's|my|our|when|where|what|why|how|which|who|is|are|do|does|did|will|should|would|shall|may|might|was|were|had|have|has)\b)\s*${INTAKE_DESTINATION_PHRASE_SRC}\s*[-–—]?\s*${duration}\b`, "iu"),
  ];
  for (const rx of patterns) {
    const match = source.match(rx);
    const cleaned = cleanProviderDestinationPhrase(match?.[1] || "");
    if (cleaned) return cleaned;
  }
  const direct = cleanProviderDestinationPhrase(source);
  return direct.split(/\s+/).length <= 4 ? direct : "";
}

function canonicalGeocodedDestinationName(result = {}, fallback = "") {
  const formattedFirstPart = String(result.formatted || "")
    .split(",")
    .map((part) => part.trim())
    .find(Boolean) || "";
  return cleanTripFactValue(
    result.name ||
    result.city ||
    result.county ||
    result.state ||
    formattedFirstPart ||
    fallback
  );
}

async function resolveIntakeDestinationCandidate(candidate = "") {
  const query = cleanProviderDestinationPhrase(candidate);
  if (!query) return null;
  try {
    let result = await geocodeArea(query, { providerTimeoutMs: 8000 });
    const confidence = Number(result?.confidence);
    const country = cleanTripFactValue(result?.country || "");
    // Worldwide-safe stricter threshold for 1-2 short words. free geocoder will
    // return real-but-irrelevant micro-places ("Plan A, United States",
    // "Plan, Italy") for bare verb fragments otherwise.
    const wordCount = query.split(/\s+/).filter(Boolean).length;
    const lettersOnly = query.replace(/[^A-Za-z]/g, "");
    const minConfidence = (wordCount <= 2 && lettersOnly.length <= 6) ? 0.9 : 0.7;
    if (!result || !country || !Number.isFinite(confidence) || confidence < minConfidence) return null;
    // Only retry with "${query} island" appended when the candidate
    // already looks island-like (single word, no comma, no "city"
    // suffix, and free geocoder's main result didn't pin a clear locality).
    // Otherwise this fires for every Tokyo/Paris/Cebu City and wastes
    // a free geocoder call per intake turn (see Scenario 6 log spam).
    const queryLooksIslandCandidate =
      !/\bisland\b/i.test(query) &&
      !/[,/]/.test(query) &&
      !/\bcity\b/i.test(query) &&
      query.trim().split(/\s+/).length <= 2 &&
      !cleanTripFactValue(result?.city || "");
    if (queryLooksIslandCandidate && /^city$/i.test(String(result.resultType || ""))) {
      const islandResult = await geocodeArea(`${query} island`, { providerTimeoutMs: 8000 });
      const islandConfidence = Number(islandResult?.confidence);
      const sameCountry = cleanTripFactValue(islandResult?.country || "").toLowerCase() === country.toLowerCase();
      const islandName = canonicalGeocodedDestinationName(islandResult || {}, "");
      const islandKey = normalizeProviderCandidateKey(islandName);
      const queryKey = normalizeProviderCandidateKey(query);
      if (
        sameCountry &&
        Number.isFinite(islandConfidence) &&
        islandConfidence >= confidence &&
        /\bisland\b/i.test(islandName) &&
        queryKey &&
        islandKey.includes(queryKey)
      ) {
        result = islandResult;
      }
    }
    const destination = canonicalGeocodedDestinationName(result, query);
    if (!destination) return null;
    return {
      destination: titleCaseIntakeValue(destination),
      country,
      confidence,
      formatted: result.formatted || "",
    };
  } catch (error) {
    console.warn("[intake] free geocoder destination resolution failed", { candidate: query, err: String(error?.message || error || "") });
    return null;
  }
}

async function resolveKnownIntakeDestinationFromText(text = "") {
  const candidate = extractProviderDestinationPhrase(text);
  return candidate ? resolveIntakeDestinationCandidate(candidate) : null;
}

async function knownIntakeDestinationFromText(text = "") {
  const resolved = await resolveKnownIntakeDestinationFromText(text);
  return resolved?.destination || "";
}

function canonicalIntakeDestinationName(value = "") {
  const raw = cleanTripFactValue(value);
  const key = normalizeIntakePlace(raw);
  if (!key) return "";
  if (/\b(?:recommend|suggest|provide|give|show|list|find)\b.*\b(?:place\s+to\s+stay|stay|hotel|hostel|accommodation|base)\b/i.test(raw)) return "";
  if (/^(?:add it|add this|add that|food and nightlife|generate the itinerary|trip summary already|the destination should be|destination should be)$/i.test(raw)) return "";
  if (/^(?:me a|me|stay|stays|hotel|hotels|place|places|where to stay|recommendation|base)$/i.test(raw)) {
    return "";
  }
  // Reject sentence fragments accidentally captured after phrases like
  // "destination should be Santa Fe why its stay first"; known-place
  // fallback should win over this kind of regex over-capture.
  if (/\b(?:why|its|it's|reply|please|first|second|third|next|previous|stay|hotel|accommodation|recommend|suggest|change|fix|update|correct|wrong|right|only|just|actually|instead)\b/i.test(raw)) {
    return "";
  }
  if (raw.split(/\s+/).filter(Boolean).length > 4) {
    return "";
  }
  return titleCaseIntakeValue(raw);
}

function monthDayToIsoForIntake(value = "", fallbackYear = new Date().getUTCFullYear()) {
  const m = String(value || "").match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,\s*(\d{4}))?\b/i);
  if (!m) return "";
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const month = months.indexOf(String(m[1] || "").toLowerCase()) + 1;
  const day = Number(m[2]);
  const year = Number(m[3] || fallbackYear);
  if (!month || !Number.isFinite(day) || day < 1 || day > 31 || !Number.isFinite(year)) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function titleCaseIntakeCity(value = "") {
  return titleCaseIntakeValue(String(value || "").replace(/[?.!,;]+$/, "").trim());
}

function extractPreTripOvernightFacts(source = "", currentFacts = {}) {
  const text = String(source || "");
  if (!/\b(?:flight|fly|plane|ferry|bus|van)\b/i.test(text)) return null;
  if (!/\b(?:overnight|stay(?:ing)?|hotel|rest)\b/i.test(text)) return null;
  if (!/\bstart\b/i.test(text)) return null;

  const travelMode = /\bferr(?:y|ies)\b/i.test(text) ? "ferry" : /\bbus\b/i.test(text) ? "bus" : /\bvan\b/i.test(text) ? "van" : "flight";
  const travelTime = (text.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i) || [])[0] || "";
  const dateRx = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?\b/gi;
  const dates = [...text.matchAll(dateRx)].map((match) => match[0]).filter(Boolean);
  const startMatch = text.match(/\bstart(?:ing)?\s+(?:on\s+|in\s+)?((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?)?\s*(early\s+morning|morning|afternoon|evening|night|\d{1,2}(?::\d{2})?\s*(?:am|pm))?/i);
  const startDate = startMatch?.[1] || "";
  const startTime = startMatch?.[2] || (/\bearly\s+morning\b/i.test(text) ? "early morning" : "");
  const dateNearTravel = (text.match(/\b(?:flight|fly|plane|ferry|bus|van|leave|leaves|depart|departs)[\s\S]{0,80}?((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?)/i) || [])[1] || "";
  const startDateKey = normalizeIntakePlace(startDate);
  let travelDate = dateNearTravel ||
    dates.find((date) => normalizeIntakePlace(date) !== startDateKey) ||
    (!startDate ? dates[0] || "" : "");
  if (travelDate && startDateKey && normalizeIntakePlace(travelDate) === startDateKey && dates.length === 1) {
    travelDate = "";
  }
  const stayCity =
    (text.match(/\bstay(?:ing)?\s+(?:in|at)\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=\s+(?:to|so|for|overnight|and)\b|[,.;]|$)/i) || [])[1] ||
    (text.match(/\bhotel\s+in\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=\s+(?:to|so|for|overnight|and)\b|[,.;]|$)/i) || [])[1] ||
    "";

  if (!startDate && !startTime && !stayCity) return null;

  const origin = String(currentFacts.origin || "").trim();
  const city = titleCaseIntakeCity(stayCity || "Manila");
  const prettyTravelDate = travelDate ? titleCaseIntakeValue(travelDate) : "";
  const prettyTravelTime = travelTime ? travelTime.toUpperCase().replace(/\s+/, " ") : "";
  const travelParts = [
    origin && city ? `${origin} → ${city}` : city ? `to ${city}` : "",
    travelMode,
    [prettyTravelDate, prettyTravelTime].filter(Boolean).join(" "),
  ].filter(Boolean);

  return {
    preTripTravel: travelParts.join(", "),
    overnightBase: city ? `${city} overnight` : null,
    itineraryStartDate: startDate ? monthDayToIsoForIntake(startDate) : null,
    itineraryStartTime: startTime ? startTime.toLowerCase() : null,
    itineraryStartPoint: city || null,
    date: startDate ? titleCaseIntakeValue(startDate) : null,
    startTime: startTime ? startTime.toLowerCase() : null,
  };
}

async function extractTripFactsFromUserText(text = "") {
  const source = normalizeIntakeDestinationTypos(text);
  const facts = {};
  if (!source) return facts;

  const correctedDestination = extractCorrectedFieldValue(source, "destination");
  const correctedOrigin = extractCorrectedFieldValue(source, "origin");
  const correctedTravelers = extractCorrectedFieldValue(source, "travelers");
  const correctedTheme = extractCorrectedFieldValue(source, "theme");
  const correctedBudget = extractCorrectedFieldValue(source, "budget");
  const correctedDate = extractCorrectedFieldValue(source, "date");
  const correctedStart = extractCorrectedFieldValue(source, "startTime");
  const correctedTransport = extractCorrectedFieldValue(source, "transportMode");
  const correctedBase = extractCorrectedFieldValue(source, "baseArea");
  const correctedComplaintDestination = extractCorrectedDestinationFromComplaint(source);

  if (
    latestUserIsComplaintOrMeta(source) &&
    !correctedComplaintDestination &&
    !extractIntakeDurationCorrectionDays(source)
  ) {
    return facts;
  }

  const correctedDays = extractIntakeDurationCorrectionDays(source);
  if (correctedDays) {
    facts.days = correctedDays;
  } else {
    const durationMatch =
      source.match(/\b(\d{1,2})\s*[- ]?\s*day(?:s)?\b/i) ||
      source.match(/\b(\d{1,2})\s*[- ]?\s*night(?:s)?\b/i) ||
      source.match(/\b(?:duration|days?)\s+(?:is|are|should be|=)\s*(\d{1,2})\b/i);
    if (durationMatch) facts.days = Number(durationMatch[1]);
  }

  const destinationPatterns = [
    /\bnew\s+trip:\s*(?:\d{1,2}\s*[- ]?\s*days?\s*)?(?:in|to)\s+([A-Za-z][A-Za-z .'-]{1,50}?)(?=\s+(?:with|from|for|on|in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))|[,.;]|$)/i,
    /\b(?:i|we)\s+(?:want|wanna|would\s+like|plan|are\s+planning|planning)\s+to\s+(?:(?:go|travel|head)\s+to|visit)\s+([A-Za-z][A-Za-z .'-]{1,50}?)(?=\s+(?:for\s+\d{1,2}\s*[- ]?\s*(?:days?|nights?)|with|from|on|in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))|[,.;]|$)/i,
    /\b(?:provide|give|make|create|build|plan)\s+(?:me\s+|us\s+)?(?:a\s+|an\s+)?(?:new\s+)?(?:\d{1,2}\s*[- ]?\s*day\s+)?(?:trip|itinerary|plan)\s+(?:to|in|for)\s+([A-Za-z][A-Za-z .'-]{1,50}?)(?=\s+(?:with|from|for|on|in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))|[,.;]|$)/i,
    /\b(?:i\s+want|plan|make|create|build|give\s+me)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:\d{1,2}\s*[- ]?\s*day\s+)?(?:trip|itinerary)\s+(?:to|in|for)\s+([A-Za-z][A-Za-z .'-]{1,50}?)(?=\s+(?:with|from|for|on|in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))|[,.;]|$)/i,
    /\b(?:i\s+want|plan|make|create|build|give\s+me)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:\d{1,2}\s*[- ]?\s*day\s+)?([A-Za-z][A-Za-z .'-]{1,50}?)\s+trip\b/i,
    /\b(?:trip|itinerary)\s+(?:to|in|for)\s+([A-Za-z][A-Za-z .'-]{1,50}?)(?=\s+(?:with|from|for|on|in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))|[,.;]|$)/i,
    /\b(?:in|to)\s+([A-Z][A-Za-z .'-]{1,50}?)(?=\s+with\b|[,.;]|$)/,
  ];
  const destinationMatch = destinationPatterns.map((rx) => source.match(rx)).find(Boolean);
  const matchedDestination = cleanTripFactValue(destinationMatch?.[1] || "");
  // Look ahead at the origin extraction so we can suppress the
  // knownIntakeDestinationFromText fallback when the only mention of the
  // place name in this message is the origin clause (e.g. "we are from
  // cebu, morning, recommend me a place"). Otherwise Cebu leaks into
  // facts.destination and the destination-change-reset path overwrites the
  // real locked destination (e.g. Camiguin).
  const preOriginMatch = source.match(/\b(?:coming\s+from|starting\s+from|origin\s+(?:is|=)|from)\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=\s*(?:[,.;]|$)|\s+(?:and|with|by|via|private|car|bus|van|flight|early|morning|afternoon|evening|start|base|hotel|budget)\b)/i);
  const preOrigin = cleanTripFactValue(correctedOrigin || preOriginMatch?.[1] || "");
  const preOriginKey = normalizeIntakePlace(preOrigin);
  const knownDestinationResolution = await resolveKnownIntakeDestinationFromText(source);
  const knownDestinationCandidate = knownDestinationResolution?.destination || "";
  const knownDestinationKey = normalizeIntakePlace(knownDestinationCandidate);
  const knownIsOnlyOrigin =
    preOriginKey &&
    knownDestinationKey &&
    preOriginKey === knownDestinationKey &&
    !matchedDestination;
  const knownDestination = knownIsOnlyOrigin ? "" : knownDestinationCandidate;
  const matchedDestinationUsable =
    matchedDestination &&
    matchedDestination.length >= 3 &&
    !/^(?:me|me a|a|trip|stay|hotel)$/i.test(matchedDestination) &&
    !invalidTripDestination(matchedDestination);
  const canonicalCorrectedDestination = canonicalIntakeDestinationName(correctedDestination);
  const canonicalComplaintDestination = canonicalIntakeDestinationName(correctedComplaintDestination);
  const rawDestination = cleanTripFactValue(
    canonicalCorrectedDestination ||
    canonicalComplaintDestination ||
    (matchedDestinationUsable ? matchedDestination : knownDestination) ||
    knownDestination
  );

  // Reject destinations that ended a sentence on a stopword fragment such
  // as "Cebu For", "Cebu Day", "Bohol Itinerary", "Manila Generate". These
  // happen when the regex captures a command verb after the city name.
  // If the trailing word is a stopword, strip it; if nothing real remains,
  // discard the extraction so we keep the previously locked destination.
  const DESTINATION_STOPWORDS = /\s+(?:for|change|rewrite|duration|day|days|generate|itinerary|please|now|next|with|trip|plan|create|build|make|reset|forget|fresh|new|visit|tour|explore|go|going|head|travel)\s*$/i;
  let destination = String(rawDestination || "").trim();
  // Strip leading command verbs like "Visit Cebu Malls" -> "Cebu Malls" -> "Cebu"
  destination = destination.replace(/^(?:visit|tour|explore|go\s+to|head\s+to|travel\s+to|plan|create|build|make|generate)\s+/i, "").trim();
  destination = destination.replace(/\s+\b(?:find|recommend|suggest|show|list|where|hotel|hotels|hostel|hostels|accommodation|accommodations|stay|stays|place\s+to\s+stay|places\s+to\s+stay)\b[\s\S]*$/i, "").trim();
  while (destination && DESTINATION_STOPWORDS.test(destination)) {
    destination = destination.replace(DESTINATION_STOPWORDS, "").trim();
  }
  // After stripping, if the remainder is "[Region] Malls/Shopping/etc.",
  // keep just the region — "Cebu Malls" -> "Cebu". The theme/style field is
  // where "malls" belongs, not the destination field.
  destination = destination.replace(/\s+(?:malls?|shopping|food|nightlife|beaches?|churches?|heritage)\s*$/i, "").trim();
  const destinationLooksLikeFragment =
    !destination ||
    destination.length < 3 ||
    /^[a-z]+$/i.test(destination) === false && /\s(?:for|change|rewrite|day|generate|itinerary)\b/i.test(destination);
  const destinationAsBoholBase = canonicalBoholBaseAreaForIntake(destination);
  const destinationAsCamiguinBase = canonicalCamiguinBaseAreaForIntake(destination);
  if (destinationAsBoholBase && /\bbohol\b/i.test(source)) {
    facts.destination = "Bohol";
    facts.country = "Philippines";
    facts.baseArea = destinationAsBoholBase;
  } else if (destinationAsCamiguinBase && /\bcamiguin\b/i.test(source)) {
    facts.destination = "Camiguin";
    facts.country = "Philippines";
    facts.baseArea = destinationAsCamiguinBase;
  } else if (destination && !destinationLooksLikeFragment && !invalidTripDestination(destination)) {
    const canonicalDestination = canonicalIntakeDestinationName(destination);
    if (!canonicalDestination) {
      // Ignore malformed captures such as "me a", "stay", or "hotel".
    } else {
      const providerDestination =
        (knownDestinationResolution && normalizeIntakePlace(knownDestinationResolution.destination) === normalizeIntakePlace(canonicalDestination))
          ? knownDestinationResolution
          : await resolveIntakeDestinationCandidate(canonicalDestination);
      facts.destination = providerDestination?.destination || canonicalDestination;
      if (providerDestination?.country) facts.country = providerDestination.country;
      // Worldwide-safe country lock. free geocoder sometimes resolves "Cebu",
      // "Manila", "Maldives", "Tokyo", etc. to a US/UK/Italian micro-place
      // and stamps a wrong country on the trip. If the destination is in
      // our known-country map, the known country always wins — the user's
      // explicit country statement (if any) is still honored later in the
      // pipeline.
      const knownCountry = typeof inferCountryForKnownDestination === "function"
        ? inferCountryForKnownDestination(facts.destination || canonicalDestination)
        : "";
      if (knownCountry && knownCountry !== facts.country) {
        facts.country = knownCountry;
      }
    }
  }

  const originMatch =
    source.match(/\b(?:coming\s+from|starting\s+from|origin\s+(?:is|=)|from)\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=\s*(?:[,.;]|$)|\s+(?:and|also|too|as\s+well|so|since|because|but|only|now|please|pls|with|by|via|to|then|while|though|if|when|that|which|where|private|car|bus|van|flight|early|morning|afternoon|evening|start|base|hotel|budget|local|trip|need|dont|don'?t)\b)/i);
  const originRaw = cleanTripFactValue(correctedOrigin || originMatch?.[1] || "")
    // Strip trailing connector / qualifier words that bled into the capture
    // ("cebu also" → "cebu", "cebu only" → "cebu", "manila please" → "manila").
    .replace(/\s+(?:also|too|as\s+well|please|pls|now|only|just|alone|exclusively|naman|lang|man|gud|ra)\s*$/i, "")
    .trim();
  const origin = containsCrossFieldClauseLeak(originRaw) ? "" : originRaw;
  if (origin && !/\b(?:previous|conversation|scratch|everything)\b/i.test(origin)) facts.origin = titleCaseIntakeValue(origin);

  const dateMatch =
    source.match(/\b(next\s+weekend|next\s+week|this\s+weekend|this\s+week)\b/i) ||
    source.match(/\b((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?)\b/i);
  const date = cleanTripFactValue(correctedDate || dateMatch?.[1] || "");
  if (date) facts.date = date;

  if (correctedTravelers) facts.travelers = correctedTravelers;
  else if (/\bwith\s+(?:my\s+)?parents\b/i.test(source)) facts.travelers = "with my parents";
  else if (/\bparents\b/i.test(source)) facts.travelers = "parents";
  else if (/\bwith\s+(?:my\s+)?family\b/i.test(source)) facts.travelers = "family";
  else if (/\bfamily\s+(?:trip|travel|vacation|getaway)\b/i.test(source)) facts.travelers = "family";
  else if (/\bwith\s+(?:my\s+)?friends\b/i.test(source)) facts.travelers = "friends";
  else if (/\bcouple|partner|girlfriend|boyfriend|wife|husband|spouse|gf|bf\b/i.test(source)) facts.travelers = "couple";
  else if (/\bsolo\b/i.test(source)) facts.travelers = "solo";

  const budget = correctedBudget ? formatIntakeBudgetLabel(correctedBudget) : extractRecentTripBudgetTier([{ role: "user", content: source }]);
  if (budget) facts.budget = budget;

  const startMatch =
    source.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ||
    source.match(/\b(early\s+morning|morning|afternoon|evening|night)\b/i);
  const start = cleanTripFactValue(correctedStart || startMatch?.[0] || "");
  if (start) facts.startTime = /\bflight\b/i.test(source) ? `${start} flight departure` : start;

  const explicitTransport = extractExplicitTransportModeFromText(source);
  const transport = cleanTripFactValue(correctedTransport || explicitTransport || (
    /\bprivate\s+car\b/i.test(source) ? "private car" :
    /\bferr(?:y|ies)\b/i.test(source) ? "ferry + local transfer" :
    /\bcar\b/i.test(source) ? "car" :
    /\bbus\b/i.test(source) ? "bus" :
    /\bvan\b/i.test(source) ? "van" :
    /\bflight\b|\bplane\b|\bfly(?:ing)?\b/i.test(source) ? "flight + local transfer" :
    ""
  ));
  if (transport) facts.transportMode = transport;
  if (!facts.transportMode && /\b(?:motorbike|motorcycle|scooter|habal[-\s]?habal)\b/i.test(source)) {
    facts.transportMode = /\bferry|port|cebu|siquijor|camiguin|bohol\b/i.test(source)
      ? "ferry + local transfer; local motorbike rental"
      : "local motorbike rental";
  }

  const preTrip = extractPreTripOvernightFacts(source, facts);
  if (preTrip) {
    for (const [field, value] of Object.entries(preTrip)) {
      if (value) facts[field] = value;
    }
  }

  const baseStatement = extractBaseStatementParts(source);
  const baseMatch =
    source.match(/\bbase\s+(?:in|near|at)\s+([A-Za-z][A-Za-z .'-]{1,50}?)(?=\s*(?:[,.;]|$)|\s+(?:near|with|for|and|private|car|budget)\b)/i) ||
    source.match(/\b(?:hotel|stay|place)\s+near\s+([A-Za-z][A-Za-z .'-]{1,50}?)(?=\s*(?:[,.;]|$)|\s+(?:and|with|for|private|car|budget)\b)/i) ||
    source.match(/\bnear\s+(Session Road|Burnham Park|Malate|Intramuros|Quiapo|Baclaran)\b/i);
  const base = cleanTripFactValue(correctedBase || baseStatement?.candidate || baseMatch?.[1] || "");
  if (base) {
    if (invalidIntakeBaseArea(base)) {
      facts.noHotelYet = true;
      facts.baseArea = null;
    } else {
      facts.baseArea = await validateBaseAreaCandidateForTrip(base, facts);
    }
  }

  // Hotel/resort selection: "i will stay here: Mabini Poolside Resort",
  // "i'll stay at <X>", "stay here: <X>", "pick <X>", "let's go with <X>".
  // Captures the explicit named accommodation choice so later normalization
  // can set hotelArea = "<Hotel>, <prior base area>" without overwriting
  // destination/baseArea/specialRequests.
  const hotelSelectionMatch =
    source.match(/\b(?:i\s*(?:'\s*ll|will)\s+stay\s+(?:here|at|in)|i\s*(?:'\s*ll|will)\s+(?:pick|choose|book|go\s+with)|i\s+pick|i\s+choose|let'?s\s+(?:pick|book|go\s+with|stay\s+at)|going\s+to\s+stay\s+at|going\s+with|going\s+for|book(?:ed|ing)?|stay\s+here|stay\s+at|we'?ll\s+stay\s+(?:at|here))\s*:?\s*([A-Za-z][A-Za-z0-9 .'&-]{2,80}?)(?=\s*[,.;!?\n]|$|\s+(?:yes|no|please|now|generate|build|then|and|can\b|could\b|should\b|i\b|we\b|i'?ll\b|we'?ll\b|i\s+mean\b|i\s+pick\b|i\s+choose\b))/i);
  let hotelName = cleanAccommodationSelectionNameForIntake(hotelSelectionMatch?.[1] || "");
  if (!hotelName && looksLikeBareAccommodationSelectionForIntake(source)) {
    hotelName = cleanAccommodationSelectionNameForIntake(source);
  }
  if (baseStatement?.candidate && hotelName) {
    hotelName = "";
  }
  // Trim trailing filler words that bled in via space-joined history concat.
  hotelName = hotelName.replace(/\s+(?:yes|no|ok|okay|yeah|yep|please|now|generate|build|then|and|can|could|should|i|we|i'?ll|we'?ll|the|a|an|some)\b.*$/i, "").trim();
  // Strip leading articles ("the Mabini Poolside Resort" -> "Mabini Poolside Resort").
  hotelName = hotelName.replace(/^(?:the|a|an)\s+/i, "").trim();
  if (hotelName && hotelName.length >= 3 && !/^(?:here|there|now|please|the|a|an|some)$/i.test(hotelName)) {
    const canonicalBase = canonicalExplicitBaseSelectionForIntake(hotelName);
    if (canonicalBase) {
      facts.baseArea = canonicalBase;
    } else {
      facts.selectedHotel = titleCaseIntakeValue(hotelName);
    }
  }

  // Auto-detect known Camiguin/Bohol base areas mentioned in the text so
  // that bare references like "Mambajao" or "Panglao" get promoted to a
  // canonical base area when destination context is also present. Prevents
  // a destination-correction reset from wiping the user-stated base.
  if (!facts.baseArea) {
    const sourceKey = normalizeIntakePlace(source);
    const knownBase = canonicalKnownBaseAreaForIntake(source);
    if (knownBase && /\bsession\s+road\b/i.test(source)) {
      facts.baseArea = knownBase;
    } else if (/\bcamiguin\b|\bmambajao\b|\byumbing\b|\bmahinog\b|\bcatarman\b|\bsagay\b/.test(sourceKey)) {
      const camiguinBase = canonicalCamiguinBaseAreaForIntake(source);
      if (camiguinBase) facts.baseArea = camiguinBase;
    } else if (/\bbohol\b|\bpanglao\b|\btagbilaran\b|\balona\b|\bdumaluan\b|\bdauis\b|\banda\b|\bloboc\b/.test(sourceKey)) {
      const boholBase = canonicalBoholBaseAreaForIntake(source);
      if (boholBase) facts.baseArea = boholBase;
    } else if (/\bsiquijor\b|\bsan\s+juan\b|\blarena\b|\blazi\b/.test(sourceKey)) {
      const siquijorBase = canonicalSiquijorBaseAreaForIntake(source);
      if (siquijorBase) facts.baseArea = siquijorBase;
    }
  }
  // User said they already have their own accommodation (house, condo, place,
  // a hotel they've booked, "no need", "local trip", "staycation"). Mark the
  // trip as needing no accommodation so the downstream pipeline does NOT
  // trigger a "Stays to check" lookup. Worldwide-safe — pure English phrases.
  const userHasOwnPlace =
    /\b(?:i|we)\s+(?:have|own|got|already\s+have|already\s+got)\s+(?:a\s+|an\s+|my\s+|our\s+|the\s+)?(?:house|home|condo|apartment|flat|place|room|villa|cottage|unit|airbnb|booked\s+stay|hotel)\b/i.test(source) ||
    /\b(?:i|we)\s+live\s+(?:in|at|here|there|near|around)\b/i.test(source) ||
    /\b(?:no\s+need|don'?t\s+need|do\s+not\s+need|skip)\b[^.\n]{0,40}\b(?:hotel|stay|accommodation|base|place\s+to\s+stay)\b/i.test(source) ||
    /\b(?:local\s+trip|staycation|day\s+trip|home(?:[-\s])?based|i'?m\s+local)\b/i.test(source) ||
    /\byes\s+(?:i|we)\s+(?:have|own|got|already\s+have)\s+(?:a\s+|an\s+|my\s+|our\s+|the\s+)?(?:house|home|condo|apartment|flat|place|room|villa|cottage|unit|airbnb|booked\s+stay|hotel|stay|accommodation)\b/i.test(source);
  if (userHasOwnPlace) {
    facts.noHotelYet = false;
    facts.hasOwnPlace = true;
    facts.hotelStatus = "user_has_own";
    if (!facts.baseArea) facts.baseArea = ""; // Not needed; rendered as "Not needed / local trip" downstream.
    facts.baseStatus = "none";
  }
  if (!userHasOwnPlace && /\b(?:(?:no|don'?t|dont|do\s+not)\s+have\s+(?:a\s+|any\s+)?(?:hotel|place|stay|base(?:\s+area)?|accommodation|inn|hostel|guesthouse|resort)|(?:we|i)\s+have\s+no\s+(?:hotel|place|stay|base(?:\s+area)?|accommodation|inn|hostel|guesthouse|resort)|(?:recommend|suggest|find|pick|choose|propose)\s+(?:me\s+)?(?:a\s+)?(?:hotel|place|stay|base|base\s+area|accommodation|inn|hostel|guesthouse|resort)|where\s+to\s+(?:stay|base)|no\s+idea\s+(?:where|what)\s+to\s+(?:stay|base|pick|choose)|don'?t\s+know\s+where\s+to\s+(?:stay|base)|you\s+(?:choose|pick|decide)|whatever\s+you\s+(?:think|suggest|recommend)|up\s+to\s+you)\b/i.test(source)) {
    facts.noHotelYet = true;
    if (invalidIntakeBaseArea(facts.baseArea)) facts.baseArea = null;
    if (!facts.baseArea && /\bbaguio\b/i.test(`${source} ${facts.destination || ""} ${facts.subArea || ""}`)) {
      facts.baseArea = "Session Road / Burnham Park / City Center";
    }
    if (!facts.baseArea && /\bcamiguin\b/i.test(`${source} ${facts.destination || ""} ${facts.subArea || ""}`)) {
      facts.baseArea = "Mambajao / Yumbing";
    }
    if (!facts.baseArea && /\bsiquijor\b/i.test(`${source} ${facts.destination || ""} ${facts.subArea || ""}`)) {
      facts.baseArea = "San Juan";
    }
  }
  const nightlyCap = formatNightlyCapFromUserText(source);
  if (nightlyCap && textHasAccommodationContext(source)) {
    facts.accommodationBudget = `${/\b(?:under|below|less\s+than|max(?:imum)?|up\s+to|no\s+more\s+than)\b/i.test(source) ? "under " : ""}${nightlyCap}/night`;
  }
  if (nightlyCap && shouldPersistNightlyCapAsSpecialRequest(source)) {
    facts.specialRequests = uniqueIntakeLabels([
      ...(Array.isArray(facts.specialRequests) ? facts.specialRequests : []),
      `Stay under ${nightlyCap}/night`,
    ]);
  }

  if (correctedTheme) facts.theme = correctedTheme;
  else if (/\bgardens?\s+and\s+church(?:es)?\b/i.test(source) || /\bchurch(?:es)?\s+and\s+gardens?\b/i.test(source)) facts.theme = "gardens and churches";
  else if (/\breligious(?:\s+focus)?\b/i.test(source)) facts.theme = "religious focus";
  else if (/\bbeach\b/i.test(source)) facts.theme = "beach";

  const breakfast = extractBreakfastPreferenceFromText(source);
  if (breakfast) {
    facts.breakfastIncluded = breakfast.breakfastIncluded;
    facts.breakfastNote = breakfast.breakfastNote;
  }

  const specialSource = baseStatement?.rest || source;
  const namedMustVisits = uniqueIntakeLabels([
    ...(await extractKnownMustVisitsFromText(specialSource, {
      destination: [facts.subArea, facts.destination].filter(Boolean).join(" "),
      country: facts.country || "",
    })),
  ]);
  if (namedMustVisits.length) {
    facts.specialRequests = uniqueIntakeLabels([
      ...(Array.isArray(facts.specialRequests) ? facts.specialRequests : []),
      ...namedMustVisits,
    ]);
  }

  const shouldCaptureSpecialRequest =
    /\b(?:include|add|visit|we\s+like|i\s+like|we\s+want|i\s+want\s+to\s+visit|strawberry\s+(?:garden|farm|picking)|la\s+trinidad|food\s+and\s+history|gardens?\s+and\s+church(?:es)?)\b/i.test(specialSource);
  const specialRequest = shouldCaptureSpecialRequest ? normalizeSpecialRequestText(specialSource) : "";
  // Suppress the long raw paragraph when the named must-visit extractor
  // already produced clean labels. Previously this appended e.g.
  // "snorkeling at White Island and Mantigue Island, visiting the iconic
  // Sunken Cemetery..." in addition to the clean labels — getting truncated
  // mid-word and cluttering the trip summary. Only fall back to the raw
  // paragraph capture when no named must-visits were extracted.
  if (
    specialRequest &&
    !namedMustVisits.length &&
    specialRequest.split(/\s+/).length <= 8 &&
    !/^recommend\b/i.test(specialRequest)
  ) {
    facts.specialRequests = uniqueIntakeLabels([
      ...(Array.isArray(facts.specialRequests) ? facts.specialRequests : []),
      specialRequest,
    ]);
  }

  return facts;
}

function recentUserTextForTripFacts(recent = [], latestUser = "") {
  let resetIndex = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (
      recent[i]?.role === "user" &&
      (
        latestUserRequestsTripReset(recent[i]?.content) ||
        // Treat fresh-destination starts as reset boundaries, but NOT
        // pure complaint corrections — those preserve prior trip facts
        // and only update the destination.
        (
          latestUserStartsFreshDestinationContext(recent[i]?.content) &&
          !extractCorrectedDestinationFromComplaint(recent[i]?.content)
        ) ||
        (
          i > 0 &&
          assistantAskedAmbiguousIslandClarification(recent[i - 1]?.content) &&
          extractDestinationFromAmbiguousIslandConfirmation(recent[i]?.content, recent[i - 1]?.content)
        )
      )
    ) {
      resetIndex = i;
      break;
    }
  }
  const source = resetIndex >= 0 ? recent.slice(resetIndex) : recent.slice(-10);
  const factSource = (latestUserRequestsTripSummary(latestUser) || latestUserIsComplaintOrMeta(latestUser))
    ? source.filter((turn, index) => !(index === source.length - 1 && turn?.role === "user"))
    : source;
  return factSource
    .filter((turn) => turn?.role === "user")
    .map((turn) => String(turn.content || ""))
    .join(" ");
}

function invalidTripDestination(value = "") {
  const raw = compactIntakeText(value);
  if (!raw) return true;
  if (raw.length > 60) return true;
  if (/^(?:me a|me|stay|stays|hotel|hotels|place|places|where to stay|recommendation|base|add it|add this|add that|food and nightlife|generate the itinerary|trip summary already|why is it)$/i.test(raw)) return true;
  return /\b(?:for|coming from|mid[-\s]?range|private car|recommend|suggest|provide|hotel|next week|early morning|place\s+to\s+stay|places\s+to\s+stay|stay\s+yet|add\s+it|food\s+and\s+nightlife|generate\s+the\s+itinerary|trip\s+summary\s+already|why\s+is\s+it)\b/i.test(raw) ||
    /[.]\s*for\b/i.test(raw);
}

function invalidTripOrigin(value = "") {
  const raw = compactIntakeText(value);
  if (!raw) return true;
  if (raw.length > 45) return true;
  return /\b(?:mid[-\s]?range|coming from|recommend|hotel|private car|next week|destination|duration|budget)\b/i.test(raw);
}

function invalidIntakeBaseArea(value = "") {
  const raw = compactIntakeText(value);
  if (!raw) return false;
  const alphaCount = (raw.match(/[A-Za-z]/g) || []).length;
  if (alphaCount > 0 && alphaCount < 4) return true;
  if (/^(?:a|an|the|some|any)\b/i.test(raw)) return true;
  return /\b(?:idea|no idea|for now|recommend|suggest|whatever|you choose|pick one|whichever|no preference|not sure|tbd)\b/i.test(raw);
}

function applyTripFacts(tripContext = {}, facts = {}, { overwrite = false } = {}) {
  const out = { ...tripContext };
  facts = { ...(facts || {}) };
  if (invalidIntakeBaseArea(facts.baseArea)) {
    facts.baseArea = null;
    facts.noHotelYet = true;
  }

  // ---------------- DURATION CHANGE RESET ----------------
  // When the user changes day count after a generation attempt, clear cached
  // itinerary state so the next confirm regenerates from scratch instead of
  // replaying a previous failure reply. Force-overwrite days when the new
  // value is a real number and differs from what is stored.
  const priorDays = Number(out.days || 0);
  const nextDays = Number(facts?.days || 0);
  const durationChanged = priorDays > 0 && nextDays > 0 && priorDays !== nextDays;
  if (durationChanged) {
    out.days = nextDays;
    out.latestItinerary = "";
    out.lastReply = "";
    out.itineraryAttempts = 0;
    out.lastItineraryFailure = "";
  }

  // ---------------- DESTINATION CHANGE RESET ----------------
  // When the user changes the locked destination (e.g. Cebu -> Bohol),
  // we must clear ALL cached itinerary state, the old subArea, the old
  // baseArea, and any anchored map stops. Without this, the next "yes"
  // can replay the previous destination's body under the new header.
  const normalizeRegion = (v) =>
    String(v || "")
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .replace(/\b(?:city|province|philippines|ph|the)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const priorDestKey = normalizeRegion(out.destination);
  const nextDestKey = normalizeRegion(facts?.destination);
  // Guard: if the "new destination" key matches an origin in the same fact
  // batch or the existing trip origin, it almost certainly came from origin
  // contamination (e.g. "from cebu" being captured as destination too).
  // Skip the reset to preserve the locked destination, baseArea, theme, etc.
  const nextOriginKey = normalizeRegion(facts?.origin);
  const priorOriginKey = normalizeRegion(out.origin);
  const looksLikeOriginContamination =
    nextDestKey &&
    ((nextOriginKey && nextDestKey === nextOriginKey) ||
      (priorOriginKey && nextDestKey === priorOriginKey));
  const destinationChanged =
    priorDestKey && nextDestKey && priorDestKey !== nextDestKey && !looksLikeOriginContamination;
  if (destinationChanged) {
    out.destination = facts.destination;
    out.subArea = facts.subArea || null;
    out.anchorPlace = null;
    out.baseArea = null;
    out.latestItinerary = "";
    out.lastReply = "";
    out.itineraryAttempts = 0;
    out.lastItineraryFailure = "";
    out.lastValidatedMapStops = null;
    out.lockedMapStops = null;
    out.specialRequests = [];
    out.selectedHotel = null;
    out.hotelArea = null;
    out.noHotelYet = false;
    // Worldwide-safe: clear local-trip / own-accommodation flags on
    // destination switch. Without this, a Cebu local-trip (hasOwnPlace=true,
    // hotelStatus=user_has_own, baseStatus=none) leaks into the next
    // destination (e.g. Thailand) and the budget breakdown emits
    // "Not applicable for a local trip" / "Accommodation: ₱0 — staying at
    // own home/base" for an international flight trip.
    out.hasOwnPlace = false;
    out.hotelStatus = null;
    out.baseStatus = null;
    out.accommodationBudget = null;
    out.transportMode = null;
    // Clear country too so a stale "Italy" / "United Kingdom" / "China"
    // from a previous fuzzy-geocode doesn't carry over.
    if (facts.country) {
      out.country = facts.country;
    } else {
      out.country = null;
    }
    out.lastEditRequest = null;
    out.routeConstraints = null;
    out.editDraft = null;
    // Don't carry forward the previous theme — it often inherits a style
    // that doesn't fit the new destination (e.g. "Religious Cebu" → Bohol).
    if (!facts?.theme) out.theme = null;
  }

  for (const [field, value] of Object.entries(facts || {})) {
    if (value == null || value === "") continue;
    if (field === "country" && !value) continue;
    if (durationChanged && field === "days") continue; // already applied above
    if (field === "specialRequests") {
      const values = Array.isArray(value) ? value : [value];
      out.specialRequests = uniqueIntakeLabels([
        ...(Array.isArray(out.specialRequests) ? out.specialRequests : []),
        ...values,
      ]);
      continue;
    }
    if (field === "breakfastIncluded") {
      if (value === true || overwrite) out.breakfastIncluded = Boolean(value);
      continue;
    }
    if (field === "breakfastNote") {
      if (overwrite || value || out.breakfastIncluded) out.breakfastNote = value;
      continue;
    }
    if (["preTripTravel", "overnightBase", "itineraryStartDate", "itineraryStartTime", "itineraryStartPoint"].includes(field)) {
      out[field] = value;
      continue;
    }
    if (field === "noHotelYet") {
      if (value === true || overwrite || out.noHotelYet == null) {
        out.noHotelYet = Boolean(value);
        if (value === true) out.hotelStatus = out.hotelStatus || "needs_recommendation";
      }
      continue;
    }
    if (overwrite || out[field] == null || out[field] === "" || isWeakContextValue(field, out[field])) {
      out[field] = value;
    }
  }
  // Worldwide-safe final country lock. If the destination is in the
  // known-country map (Cebu/Manila/Maldives/Tokyo/Bangkok/...), force the
  // country to match — overriding any fuzzy-geocode result like
  // "United States" / "United Kingdom" / "Italy" / "China". This runs once
  // after all fact merges so it applies to every call site of
  // applyTripFacts.
  const knownCountry = typeof inferCountryForKnownDestination === "function"
    ? inferCountryForKnownDestination(out.destination || out.subArea || "")
    : "";
  if (knownCountry && knownCountry !== out.country) {
    out.country = knownCountry;
  }
  return out;
}

function sanitizeTripContextForIntake(tripContext = {}, facts = {}, latestFacts = {}) {
  const out = { ...tripContext };
  for (const field of ["destination", "subArea", "baseArea", "origin"]) {
    if (typeof out[field] === "string") out[field] = normalizeIntakeDestinationTypos(out[field]);
  }
  // Worldwide-safe: strip a trailing country (or repeated country) from the
  // destination string so the rendered summary doesn't show
  // "Cebu, Philippines, Philippines". Catches `<city>, <country>` and
  // `<city>, <country>, <country>` patterns by collapsing to `<city>` when
  // out.country already holds that country.
  if (typeof out.destination === "string" && out.destination) {
    const country = String(out.country || "").trim();
    if (country) {
      const countryRx = new RegExp(`\\s*,\\s*${country.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:\\s*,\\s*${country.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")})*\\s*$`, "i");
      const stripped = out.destination.replace(countryRx, "").trim();
      if (stripped && stripped !== out.destination) {
        out.destination = stripped;
      }
    }
    // Collapse any `, X, X` repeat in the destination itself.
    out.destination = out.destination.replace(/(?:,\s*([^,]+?))(?:\s*,\s*\1)+(?=\s*,|\s*$)/gi, ", $1").trim();
  }
  if (/\bcamiguin\b/i.test(String(out.destination || out.subArea || ""))) {
    out.destination = "Camiguin";
    out.country = out.country || "Philippines";
    if (/\bcamiguin\b/i.test(String(out.subArea || ""))) out.subArea = "";
  }
  if (invalidTripDestination(out.subArea || out.destination)) {
    out.destination = latestFacts.destination || facts.destination || null;
    out.subArea = latestFacts.subArea || facts.subArea || null;
  }
  if (invalidTripOrigin(out.origin)) out.origin = latestFacts.origin || facts.origin || null;
  if (/general traveler|assumption accepted/i.test(String(out.travelers || ""))) {
    out.travelers = latestFacts.travelers || facts.travelers || null;
  }
  if (/flexible date|assumption accepted/i.test(String(out.date || "")) && out.userAcceptsDefault !== true) {
    out.date = latestFacts.date || facts.date || null;
  }
  if (/practical morning|assumption accepted/i.test(String(out.startTime || "")) && out.userAcceptsDefault !== true) {
    out.startTime = latestFacts.startTime || facts.startTime || null;
  }
  // Worldwide-safe base-label scrub. LLM/regex passes occasionally
  // concatenate trip-length and date-correction wording into the base
  // ("General Luna For 3 Days", "General Luna Since May Has Paased It").
  // Strip these trailing fragments and collapse repeats.
  if (typeof out.baseArea === "string" && out.baseArea) {
    let scrubbed = out.baseArea
      // Drop trailing "for N days", "for N day", "for N nights" etc.
      .replace(/\s+for\s+\d+\s+(?:days?|nights?)\b[\s\S]*$/i, "")
      // Drop trailing "Since/Because/Note/Change date wording".
      .replace(/\s+(?:since|because|note|change|edit|update|fix)\b[\s\S]*$/i, "")
      // Drop a trailing "<duration>" duplicate (e.g. "For 3 Days For 3 Days")
      .replace(/(\bfor\s+\d+\s+(?:days?|nights?)\b)(?:\s+\1)+/gi, "$1")
      // Collapse repeated base name ("General Luna General Luna" or
      // "General Luna, General Luna").
      .replace(/^(.+?)(?:[,\s]+\1)+(?=\s|$|,)/i, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
    // Strip stray trailing prepositions/articles after a strip.
    scrubbed = scrubbed.replace(/[,\s]+(?:in|at|near|on|for|since|because|change|of|the)\s*$/i, "").trim();
    if (scrubbed && scrubbed !== out.baseArea) {
      out.baseArea = scrubbed;
    }
  }
  const canonicalBaseArea = canonicalKnownBaseAreaForIntake(out.baseArea);
  if (canonicalBaseArea) out.baseArea = canonicalBaseArea;
  if (invalidIntakeBaseArea(out.baseArea)) {
    out.baseArea = latestFacts.baseArea && !invalidIntakeBaseArea(latestFacts.baseArea)
      ? latestFacts.baseArea
      : facts.baseArea && !invalidIntakeBaseArea(facts.baseArea)
      ? facts.baseArea
      : null;
    out.noHotelYet = true;
  }
  if (/major transfer from|using provider|route/i.test(String(out.transportMode || ""))) {
    out.transportMode = latestFacts.transportMode || facts.transportMode || null;
  }
  if (latestFacts.theme && /religious/i.test(String(out.theme || "")) && /gardens?\s+and\s+church/i.test(latestFacts.theme)) {
    out.theme = latestFacts.theme;
  }
  if (out.breakfastIncluded && !out.breakfastNote) out.breakfastNote = "included";
  out.specialRequests = uniqueIntakeLabels(Array.isArray(out.specialRequests) ? out.specialRequests : []);
  normalizeDestinationBaseSeparationForIntake(out);
  if (typeof out.selectedHotel === "string") {
    out.selectedHotel = cleanAccommodationSelectionNameForIntake(out.selectedHotel);
    const selectedHotelBase = canonicalExplicitBaseSelectionForIntake(out.selectedHotel);
    if (selectedHotelBase) {
      out.baseArea = selectedHotelBase;
      out.selectedHotel = "";
      out.hotelArea = "";
    }
  }
  if (typeof out.hotelArea === "string") {
    out.hotelArea = cleanAccommodationSelectionNameForIntake(out.hotelArea);
    const hotelAreaBase = canonicalExplicitBaseSelectionForIntake(out.hotelArea);
    if (hotelAreaBase && normalizeIntakePlace(out.hotelArea).includes(normalizeIntakePlace(hotelAreaBase).split(" ")[0] || "")) {
      out.baseArea = out.baseArea || hotelAreaBase;
      out.hotelArea = hotelAreaBase;
    }
  }
  return out;
}

function normalizeDestinationBaseSeparationForIntake(tripContext = {}) {
  if (!tripContext || typeof tripContext !== "object") return tripContext;

  const destinationText = String(tripContext.destination || "").trim();
  const subAreaText = String(tripContext.subArea || "").trim();
  const baseText = String(tripContext.baseArea || "").trim();

  const boholBase =
    canonicalBoholBaseAreaForIntake(destinationText) ||
    canonicalBoholBaseAreaForIntake(subAreaText) ||
    canonicalBoholBaseAreaForIntake(baseText);
  if (boholBase) {
    tripContext.destination = "Bohol";
    tripContext.country = tripContext.country || "Philippines";
    tripContext.baseArea = boholBase;
    tripContext.subArea = "";
    return tripContext;
  }

  const camiguinBase =
    canonicalCamiguinBaseAreaForIntake(destinationText) ||
    canonicalCamiguinBaseAreaForIntake(subAreaText) ||
    canonicalCamiguinBaseAreaForIntake(baseText);
  if (camiguinBase) {
    tripContext.destination = "Camiguin";
    tripContext.country = tripContext.country || "Philippines";
    tripContext.baseArea = camiguinBase;
    tripContext.subArea = "";
  }

  const bantayanBase = canonicalKnownBaseAreaForIntake(destinationText) ||
    canonicalKnownBaseAreaForIntake(subAreaText) ||
    canonicalKnownBaseAreaForIntake(baseText);
  if (bantayanBase && /\bbantayan\b|\bsanta\s+fe\b|\bsta\s+fe\b/i.test(`${destinationText} ${subAreaText} ${baseText}`)) {
    tripContext.destination = "Bantayan Island";
    tripContext.country = tripContext.country || "Philippines";
    tripContext.baseArea = tripContext.baseArea || (/\bsanta\s+fe\b|\bsta\s+fe\b/i.test(bantayanBase) ? bantayanBase : "");
    if (/\bsanta\s+fe\b|\bsta\s+fe\b/i.test(`${destinationText} ${subAreaText}`)) {
      tripContext.subArea = "Santa Fe";
    }
  }

  return tripContext;
}

function isLocalIntakeTrip(tripContext = {}) {
  const origin = normalizeIntakePlace(tripContext?.origin || "");
  if (!origin) return false;
  const destinationCandidates = [
    tripContext?.subArea,
    tripContext?.destination,
    tripContext?.country,
  ].map((v) => normalizeIntakePlace(v || "")).filter(Boolean);
  if (!destinationCandidates.length) return false;
  return destinationCandidates.some((d) =>
    d === origin || d.includes(origin) || origin.includes(d)
  );
}

function defaultTransportModeForTrip(tripContext = {}) {
  const origin = normalizeIntakePlace(tripContext?.origin || "");
  const destination = normalizeIntakePlace(
    `${tripContext?.subArea || ""} ${tripContext?.baseArea || ""} ${tripContext?.destination || ""} ${tripContext?.country || ""}`
  );
  if (!origin || !destination) return "";
  const originFirst = origin.split(/\s+/).filter(Boolean)[0] || "";
  const destFirst = destination.split(/\s+/).filter(Boolean)[0] || "";
  if (originFirst && destFirst && originFirst === destFirst) return "local transport only";
  return "";
}

function sameRegion(a = {}, b = {}) {
  const same = (left = "", right = "") => {
    const l = normalizeIntakePlace(left);
    const r = normalizeIntakePlace(right);
    return Boolean(l && r && (l === r || l.includes(r) || r.includes(l)));
  };
  return (
    same(a.city, b.city) ||
    same(a.county, b.county) ||
    same(a.state, b.state)
  );
}

function sameCity(a = {}, b = {}) {
  const originCity = normalizeIntakePlace(a?.city || a?.name || "");
  const destinationCity = normalizeIntakePlace(b?.city || b?.name || "");
  return Boolean(originCity && destinationCity && (originCity === destinationCity || originCity.includes(destinationCity) || destinationCity.includes(originCity)));
}

// Known Philippine island/inter-region destinations that almost always
// require a flight or ferry leg from the typical traveler's origin (not
// reachable by land). The string is matched against the haystack of
// destination / sub-area / base-area / geo name so spelling variants
// ("Siargao", "siargao island", "Siargao, Surigao del Norte") all hit.
const PH_INTER_ISLAND_DESTINATION_RX =
  /\b(?:siargao|bohol|panglao|palawan|el\s*nido|coron|puerto\s+princesa|boracay|caticlan|kalibo|camiguin|bantayan|malapascua|siquijor|samar|leyte|tacloban|biliran|catanduanes|marinduque|romblon|masbate|guimaras|negros|dumaguete|bacolod|sicogon|gigantes|cuyo|batanes|basilan|tawi[-\s]*tawi|sulu|jolo)\b/i;

function destinationLooksLikeIsland(tripContext = {}, destinationGeo = {}) {
  const haystack = [
    tripContext?.destination,
    tripContext?.subArea,
    tripContext?.baseArea,
    destinationGeo?.name,
    destinationGeo?.formatted,
    destinationGeo?.resultType,
  ].filter(Boolean).join(" ");
  if (/\b(?:island|isla|isle|archipelago|atoll)\b/i.test(haystack)) return true;
  if (PH_INTER_ISLAND_DESTINATION_RX.test(haystack)) return true;
  return false;
}

// Worldwide-safe: Philippine inter-island routes where the destination is
// reachable by flight from major hubs (not by land or ferry from typical
// origins). Distinct from `destinationLooksLikeIsland` because some
// Philippine islands (Camiguin, Bantayan) are reachable by ferry-only,
// while others (Siargao, Palawan, Bohol) are usually reached by flight.
const PH_FLIGHT_ONLY_DESTINATION_RX =
  /\b(?:siargao|palawan|el\s*nido|coron|puerto\s+princesa|tacloban|batanes|basilan|tawi[-\s]*tawi|sulu|jolo)\b/i;

async function inferTransportModeFromOriginDestination(tripContext = {}) {
  const origin = String(tripContext?.origin || "").trim();
  const destination = formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext);
  if (!origin || !destination || destination === "the destination") return "";

  try {
    const [originGeo, destinationGeo] = await Promise.all([
      geocodeArea(origin, { providerTimeoutMs: 8000 }),
      geocodeArea(destination, { providerTimeoutMs: 8000 }),
    ]);
    if (!originGeo || !destinationGeo) return "";

    const originCountry = String(originGeo.countryCode || originGeo.country || "").trim();
    const destinationCountry = String(destinationGeo.countryCode || destinationGeo.country || "").trim();
    const differentCountry =
      originCountry &&
      destinationCountry &&
      originCountry.toLowerCase() !== destinationCountry.toLowerCase();
    if (differentCountry) return "international flight + local transfer";

    const island = destinationLooksLikeIsland(tripContext, destinationGeo);
    if (sameCity(originGeo, destinationGeo) && !island) return "local transport only";

    // Philippine inter-island flight-only destinations (Siargao, Palawan,
    // Coron, El Nido, Tacloban, Batanes, etc.) need a flight regardless of
    // straight-line distance — bus + ferry isn't realistic from most
    // Philippine origins.
    const destinationHaystack = [
      tripContext?.destination,
      tripContext?.subArea,
      tripContext?.baseArea,
      destinationGeo?.name,
      destinationGeo?.formatted,
    ].filter(Boolean).join(" ");
    if (PH_FLIGHT_ONLY_DESTINATION_RX.test(destinationHaystack)) {
      return "flight + local transport (ferry/multi-leg only if the user explicitly prefers it)";
    }

    if (island) return "flight or ferry + local transport";

    if (sameRegion(originGeo, destinationGeo)) return "local transport only";

    const distanceKm = distanceKmBetween(originGeo, destinationGeo);
    if (Number.isFinite(distanceKm) && distanceKm > 500) {
      return "flight or bus/van + local transport";
    }
    return "bus/van + local transport";
  } catch (error) {
    console.warn("[intake] transport inference failed", { err: String(error?.message || error || "") });
    return "";
  }
}

async function maybeInferTransportModeFromRoute(tripContext = {}) {
  if (!tripContext || typeof tripContext !== "object") return tripContext;
  if (String(tripContext.transportMode || "").trim()) return tripContext;
  const mode = await inferTransportModeFromOriginDestination(tripContext);
  if (!mode) return tripContext;
  tripContext.transportMode = mode;
  const destinationGeo = await geocodeArea(
    formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext),
    { providerTimeoutMs: 8000 }
  );
  const originGeo = await geocodeArea(tripContext.origin, { providerTimeoutMs: 8000 });
  console.log("[intake] transport inferred from origin -> destination:", mode, {
    origin: originGeo?.countryCode || originGeo?.country || "",
    destination: destinationGeo?.countryCode || destinationGeo?.country || "",
    island: destinationLooksLikeIsland(tripContext, destinationGeo || {}),
  });
  return tripContext;
}

function isGenericTransportMode(value = "") {
  return /^(?:public\s+transport|public\s+transit|commute(?:\/public\s+transport)?|commuting|no\s+preference|any|either)$/i.test(
    String(value || "").trim()
  );
}

function recomputeTripEssentialsComplete(tripContext = {}) {
  const localTrip = isLocalIntakeTrip(tripContext);
  const baseSatisfied =
    localTrip ||
    tripContext.baseArea ||
    tripContext.noHotelYet === true;
  return Boolean(
    hasUsableIntakeDestination(tripContext) &&
    Number(tripContext.days || 0) > 0 &&
    tripContext.date &&
    tripContext.travelers &&
    tripContext.budget &&
    tripContext.origin &&
    tripContext.startTime &&
    (tripContext.transportMode || localTrip) &&
    baseSatisfied
  );
}

function formatIntakeDateRange(dateText = "", days = 0, fallbackYear = "") {
  const raw = String(dateText || "").trim();
  if (!raw) return "";
  const dayCount = Number(days || 0);
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const monthIndex = (name) => monthNames.findIndex((m) => m.toLowerCase() === String(name || "").toLowerCase());

  // Already a range like "May 15–17, 2026" or "May 15-17"
  if (/[–—]/.test(raw) && /\b\d{1,2}\b/.test(raw)) {
    return raw;
  }

  const formatRange = (mi, startDay, year) => {
    const start = new Date(Date.UTC(year, mi, startDay, 12, 0, 0));
    if (dayCount > 1) {
      const end = new Date(start);
      end.setUTCDate(start.getUTCDate() + dayCount - 1);
      const startMonth = monthNames[start.getUTCMonth()];
      const endMonth = monthNames[end.getUTCMonth()];
      const startLabel = `${startMonth} ${start.getUTCDate()}`;
      const endLabel = startMonth === endMonth && start.getUTCFullYear() === end.getUTCFullYear()
        ? `${end.getUTCDate()}`
        : `${endMonth} ${end.getUTCDate()}`;
      return `${startLabel}–${endLabel}, ${end.getUTCFullYear()}`;
    }
    return `${monthNames[mi]} ${start.getUTCDate()}, ${start.getUTCFullYear()}`;
  };

  // ISO date input: 2026-06-14
  const iso = raw.match(/^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/);
  if (iso) {
    const year = Number(iso[1]);
    const mi = Number(iso[2]) - 1;
    const startDay = Number(iso[3]);
    if (mi >= 0 && mi <= 11 && Number.isFinite(startDay)) {
      return formatRange(mi, startDay, year);
    }
  }

  const m = raw.match(/^\s*(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,\s*(\d{4}))?\s*$/i);
  if (m) {
    const mi = monthIndex(m[1]);
    const startDay = Number(m[2]);
    const year = Number(m[3] || fallbackYear || new Date().getUTCFullYear());
    if (mi >= 0 && Number.isFinite(startDay) && Number.isFinite(year)) {
      return formatRange(mi, startDay, year);
    }
  }

  if (m && !m[3] && fallbackYear) {
    return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}, ${fallbackYear}`;
  }
  return raw;
}

function buildRecommendedBaseReason(hotelArea = "", destination = "", tripContext = {}, requests = []) {
  const hotelKey = normalizeIntakePlace(hotelArea || "");
  const destKey = normalizeIntakePlace(destination || "");
  const travelers = String(tripContext?.travelers || "").toLowerCase();
  const audience = /family|parents|kids|children/.test(travelers)
    ? "your family"
    : /couple|partner|honeymoon/.test(travelers)
    ? "you both"
    : /friends|barkada/.test(travelers)
    ? "your group"
    : "you";
  const mustVisitClause = (requests || [])
    .filter((r) => /\b(?:landmark|museum|temple|church|cathedral|shrine|river|cave|falls?|forest|sanctuary|lagoon|beach|island|view(?:point)?|park|tower|monument)\b/i.test(r))
    .slice(0, 1)
    .map((r) => `, while still making ${r} doable as a day trip`)
    .join("");

  if (/\btagbilaran/.test(hotelKey)) {
    return `Tagbilaran City is the most practical launch point with the easiest ferry access and onward transfers to Panglao, Loboc, and the Chocolate Hills route${mustVisitClause}.`;
  }
  // Most-specific Camiguin base wins. Only fall back to Mambajao when the
  // hotelKey actually says Mambajao/Yumbing (or no hotelKey at all and
  // destination is Camiguin) — previously this branch swallowed Sagay /
  // Mahinog / Catarman because of the destKey clause and printed "Mambajao
  // is the best..." under a "Recommended base: Sagay" header.
  if (/\bmahinog/.test(hotelKey)) {
    return `Mahinog is a calm east-side Camiguin base for ${audience} — closer to Benoni port for arrivals/departures and within a manageable drive of the main hot springs, beaches, and tour pickup points.`;
  }
  if (/\bcatarman/.test(hotelKey)) {
    return `Catarman works well for ${audience} interested in northern Camiguin sights — Sunken Cemetery, Old Church Ruins, Tuasan Falls, and the cold springs are all within a short drive.`;
  }
  if (/\bsagay/.test(hotelKey)) {
    return `Sagay is a quieter, more local Camiguin base for ${audience} who prefer a slower pace away from the busiest Mambajao/Yumbing strip; tour pickups still reach Sagay, just expect slightly longer transfers to White Island and the main food strip.`;
  }
  if (
    /\bmambajao|yumbing/.test(hotelKey) ||
    (!hotelKey && /\bcamiguin/.test(destKey))
  ) {
    return `Mambajao / Yumbing is the best all-around Camiguin base for ${audience}: food access, White Island boats, transport rentals, waterfalls, hot springs, and common tour routes stay close.`;
  }
  if (/\bpanglao|alona|bohol/.test(hotelKey) || /\bbohol|panglao/.test(destKey)) {
    return `This keeps ${audience} close to beach areas, restaurants, and tour pickup points${mustVisitClause}.`;
  }
  if (/\bel nido|palawan|coron/.test(hotelKey)) {
    return `This keeps ${audience} near the port and town for easy island-hopping access${mustVisitClause}.`;
  }
  if (/\bintramuros|ermita|malate|makati|bgc|manila/.test(hotelKey)) {
    return `This keeps ${audience} near the heritage and food stops with easy transit access${mustVisitClause}.`;
  }
  if (/\bsession road|burnham|baguio/.test(hotelKey)) {
    return `This keeps ${audience} walkable to Session Road, food spots, and the main viewpoints${mustVisitClause}.`;
  }
  return `This keeps ${audience} close to food, transfers, and the main route${mustVisitClause}.`;
}

function inferStyleLabel(tripContext = {}, recent = []) {
  const explicit = String(tripContext?.style || tripContext?.theme || "").trim();
  const simpleExplicitCanBeEnriched =
    /^(?:romantic|romance|budget|churches?|religious|beach|nature|food|history)$/i.test(explicit);
  if (explicit && !/^general\s+travel$/i.test(explicit) && !simpleExplicitCanBeEnriched) return explicit;

  const requests = Array.isArray(tripContext?.specialRequests) ? tripContext.specialRequests : [];
  // Scope theme signals to the CURRENT trip's user messages only — prior
  // trips in the same conversation (e.g. a finished Bohol "churches, food"
  // run) must not leak "Churches" into a fresh Camiguin trip's style.
  // We use the recent-text helper's reset boundary to slice the relevant
  // history.
  const scopedRecentUserText = recentUserTextForTripFacts(recent || []);
  const allText = [
    explicit,
    ...requests,
    scopedRecentUserText,
  ].join(" ").toLowerCase();

  const travelers = String(tripContext?.travelers || "").toLowerCase();
  // Use the travelers field strictly — do not infer "family" from the
  // word "family" sneaking into other free text. The blueprint says
  // Travelers: couple ⇒ style must NOT call it family.
  const isFamily = /\b(family|parents|kids|children|seniors?)\b/.test(travelers);
  const isCouple = /\b(couple|partner|spouse|girlfriend|boyfriend|honeymoon|anniversary|with my partner|with partner)\b/.test(travelers);
  const isSolo = /\b(solo|alone|just me)\b/.test(travelers);
  const isFriends = /\b(friends|barkada|group of friends)\b/.test(travelers);
  const isBudget = /\bbudget|cheap|affordable|tipid\b/.test(String(tripContext?.budget || "")) || /\bbudget|cheap|affordable|tipid\b/.test(allText);
  const isRomantic = /\bromantic|romance|date\s+trip|anniversary|honeymoon\b/.test(allText);
  if (isRomantic && isCouple) {
    return isBudget ? "romantic budget couple trip" : "romantic couple trip";
  }

  const signals = [];
  // "Religious places focus" should only fire when the trip is mainly
  // religious — explicit words like "religious", "pilgrim", "faith trip",
  // "religious focus". Adding "visit churches" alone does NOT make it a
  // religious-focus trip; treat it as a Churches/heritage signal instead.
  const explicitlyReligious = /\b(religious\s+(?:trip|focus|tour|places)|pilgrim|faith\s+trip|religious-only|all\s+religious)\b/.test(allText);
  const mentionsChurches = /\b(church(?:es)?|cathedral|basilica|shrine)\b/.test(allText);
  if (explicitlyReligious) signals.push("Religious places focus");
  else if (mentionsChurches) signals.push("Churches");
  if (/\b(food|kainan|cuisine|restaurants?|eat|dishes?|silog|street food|famous foods?)\b/.test(allText)) signals.push("Food");
  if (/\b(history|historic|heritage|museum|fort|ruins?|colonial)\b/.test(allText) && !mentionsChurches) signals.push("History");
  if (/\b(nature|hike|hiking|trek|trail|waterfall|river|mountain|jungle|forest|park|landmark|viewpoint)\b/.test(allText)) signals.push("Nature");
  if (/\b(beach|island|snorkel|dive|diving|lagoon|swim|seaside)\b/.test(allText)) signals.push("Beach");
  if (/\b(shopping|mall|malls|market|night market|souvenir|pasalubong)\b/.test(allText)) signals.push("Shopping");
  if (/\b(nightlife|bar|bars|club|clubs|rooftop|drinks)\b/.test(allText)) signals.push("Nightlife");
  if (/\b(all major|major highlights|highlights|all\s+(?:of\s+)?(?:it|them)|cover everything)\b/.test(allText) && !signals.length) {
    signals.push("Highlights");
  }

  if (!signals.length) {
    if (isCouple) return "Couple-friendly highlights";
    if (isFriends) return "Friends-trip highlights";
    if (isFamily) return "Family-friendly highlights";
    if (isSolo) return "Solo-traveler highlights";
    return explicit || "";
  }

  const unique = Array.from(new Set(signals));
  const prefix = isFamily
    ? "Family-friendly"
    : isCouple
    ? "Couple-friendly"
    : isFriends
    ? "Friends-trip"
    : isSolo
    ? "Solo-traveler"
    : "";
  if (prefix) {
    if (unique.length === 1) return `${prefix} ${unique[0].toLowerCase()}`;
    return `${prefix} mixed trip — ${unique.join(", ").toLowerCase()}`;
  }
  if (unique.length === 1) return unique[0];
  return `Mixed — ${unique.join(", ").toLowerCase()}`;
}

function dropStyleFromIntakeRequests(requests = [], style = "") {
  const styleKey = normalizeIntakePlace(style || "");
  if (!styleKey) return requests;
  const actionableRequestRx =
    /\b(?:famous\s+local\s+food|food|foods|church|churches|cathedral|basilica|shrine|nightlife|bars?|camp\s+sawi|beach|market|local\s+food|must\s+try|gardens?)\b/i;
  return (requests || []).filter((req) => {
    const k = normalizeIntakePlace(req || "");
    if (!k) return false;
    if (k === styleKey) return false;
    if (styleKey.includes(k) || k.includes(styleKey)) {
      return actionableRequestRx.test(String(req || ""));
    }
    return true;
  });
}

// Normalize raw user-provided pending-edits/special-request phrases so the
// trip summary stays clean (e.g. "visit Chocolate Hills" -> "Chocolate Hills",
// "visit churches and famous foods in bohol" → "Churches and famous Bohol food stops").
function normalizeSpecialRequestPhrase(raw = "") {
  let s = stripSpecialRequestImperatives(raw);
  if (!s) return "";
  if (/^(?:it|them|this|that|those|these)$/i.test(s)) return "";
  if (latestUserIsComplaintOrMeta(s)) return "";

  // Drop full conversational sentences that were copied wholesale into
  // pending edits (e.g. "Plan Me a 3 Day Bohol Trip I Want to Visit All If
  // That Possible in 3 Day"). Anything that looks like a sentence with a
  // verb fragment and >7 words is rejected.
  const wordCount = s.split(/\s+/).filter(Boolean).length;
  if (wordCount > 9 && /\b(plan me|i want|i'd like|i would|can you|please|let me)\b/i.test(s)) {
    return "";
  }
  // Drop bare month/date fragments that leak in ("Jun", "June", "2026").
  if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|\d{4})\.?$/i.test(s)) return "";
  // Drop bare budget tier words that already appear in the Budget field.
  if (/^(?:budget|mid[-\s]?range|midrange|luxury)$/i.test(s)) return "";
  if (/^(?:yes|yep|yeah|ok|okay|sure|generate|genrate|generate it|genrate it|provide (?:me )?(?:the )?trip summary|show (?:me )?(?:the )?trip summary)$/i.test(s)) return "";
  if (/\b(?:recommend|suggest|find|show|list|where)\b[\s\S]{0,50}\b(?:base|hotel|hostel|accommodation|accomodation|accomadation|place\s+to\s+stay|places\s+to\s+stay|stay|lodging|room)\b/i.test(s)) return "";
  if (/\b(?:show|provide|give|send)\b[\s\S]{0,40}\b(?:itinerary|trip\s+summary|summary)\b/i.test(s)) return "";
  if (/\b(?:cozy|cosy|cheap|cheapest|budget)\b[\s\S]{0,40}\b(?:stay|hotel|hostel|room|place\s+to\s+stay|accommodation|lodging)\b/i.test(s)) return "";
  if (/\b(?:motorbike|motorcycle|scooter|habal[-\s]?habal)\s+rental\b/i.test(s)) return "";
  if (formatNightlyCapFromUserText(s) && latestUserRequestsAccommodationRecommendations(s)) return "";

  s = s
    .replace(/^(?:please\s+)?(?:add|include|visit|see|go to|try)\s+/i, "")
    .replace(/\bin\s+bohol\b/i, "in Bohol")
    // Preserve thousands separators: "PHP 3,000" must NOT become "PHP 3, 000".
    .replace(/(\d),\s+(\d{3})\b/g, "$1,$2")
    .replace(/(?:₱|php|PHP)\s*(\d{1,3})\s*,\s*(\d{3})/g, (m, a, b) => {
      const prefix = /^php/i.test(m) ? "PHP " : "₱";
      return `${prefix}${a},${b}`;
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  // Title-case lightly while keeping small words lowercase.
  // small words lowercase ("and", "in", "the", "of"). We tokenize on
  // whitespace only — numbers like "3,000" stay together.
  const smalls = new Set(["and","in","the","of","or","with","a","an","on","at","to","per","under","over","up","into"]);
  s = s.split(/\s+/).map((w, i) => {
    const lower = w.toLowerCase();
    if (i > 0 && smalls.has(lower)) return lower;
    // Preserve PHP/peso casing
    if (/^php$/i.test(lower)) return "PHP";
    if (/^₱/.test(lower)) return lower;
    // Don't title-case pure numeric tokens like "3,000" or "2,500/night".
    if (/^[\d,./-]+(?:\/(?:night|day|person|pax))?$/i.test(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(" ");
  // Common rewrites for readability.
  s = s.replace(/\bChocolate Hills Too\b/i, "Chocolate Hills");
  s = s.replace(/\bChurches And Famous Foods?\b/i, "Churches and famous food stops");
  s = s.replace(/\bFamous Foods In Bohol\b/i, "Famous Bohol food stops");
  s = s.replace(/\bFamous Bohol Food Stops\b/i, "Famous Bohol food stops");
  s = s.replace(/\bFamous Food Stops And Churches\b/i, "Famous Bohol food stops and churches");
  s = s.replace(/\bFamous Bohol Food Stops And Churches\b/i, "Famous Bohol food stops and churches");
  s = s.replace(/\bFood And Nightlife Add It On Itinerary\b/i, "famous local food, light nightlife");
  s = s.replace(/\bFamous Food And Church(?:es)? To Visit\b/i, "famous local food, churches");
  s = s.replace(/\bFamous Foods? And Church(?:es)?\b/i, "famous local food, churches");
  s = s.replace(/\bFood And Nightlife\b/i, "famous local food, light nightlife");
  s = s.replace(/\bFamous Local Food\b/i, "famous local food");
  s = s.replace(/\b(Famous Bohol food stops|Famous food stops|Food stops)\s+stops\b/i, "$1");
  s = s.replace(/\bAll Major Bohol Highlights\b/i, "All major Bohol highlights");
  s = s.replace(/^Churches$/i, "churches");
  s = s.replace(/\bUnder Php\s*(\d)/i, (_, n) => `Under PHP ${n}`);
  s = s.replace(/\bUnder\s+Php\s*(\d{1,3}(?:,\d{3})*)\b/i, (_, n) => `Under PHP ${n}`);
  s = s.replace(/\bUnder\s+₱\s*(\d{1,3}(?:,\d{3})*)\s+per\s+night\b/i, (_, n) => `Under ₱${n}/night`);
  s = s.replace(/\bUnder\s+PHP\s*(\d{1,3}(?:,\d{3})*)\s+per\s+night\b/i, (_, n) => `Under PHP ${n}/night`);
  s = s.replace(/\bStay\s+Under\s+(PHP\s+\d{1,3}(?:,\d{3})*)\/night\b/i, (_, n) => `Under ${n}/night`);
  s = s.replace(/\bPer\s*Night\b/i, "per night");
  s = s.replace(/\b(\d{1,3}(?:,\d{3})*)\s*\/?\s*night\b/i, (_, n) => `${n}/night`);
  s = s.replace(/^Recommend Stay(?:\s+in\s+([A-Za-z][A-Za-z ]+))?$/i, (_, p1) => `Recommend stay${p1 ? ` in ${p1.trim()}` : ""}`);
  s = s.replace(/^Visit All If That Possible In 3 Day$/i, "All major highlights");
  return s;
}

function normalizeSpecialRequestList(list = []) {
  const normalized = uniqueIntakeLabels(
    (Array.isArray(list) ? list : [])
      .map(normalizeSpecialRequestPhrase)
      .filter(Boolean)
  );
  const hasFoodChurches = normalized.some((item) =>
    /\bfamous\s+bohol\s+food\s+stops\s+and\s+churches\b/i.test(item)
  );
  const hasLocalFoodChurches = normalized.some((item) =>
    /\bfamous\s+local\s+food\b[\s,]+churches\b|\bchurches\b[\s,]+famous\s+local\s+food\b/i.test(item)
  );
  const hasFoodNightlife = normalized.some((item) =>
    /\bfamous\s+local\s+food\b[\s,]+light\s+nightlife\b|\blight\s+nightlife\b[\s,]+famous\s+local\s+food\b/i.test(item)
  );
  const seenBudgetCaps = new Set();
  return normalized.filter((item) => {
    const key = normalizeIntakePlace(item);
    if (hasFoodChurches && /^(?:famous bohol food stops|churches|churches and famous food stops)$/.test(key)) {
      return false;
    }
    if (hasLocalFoodChurches && /^(?:churches|famous local food)$/.test(key)) {
      return false;
    }
    if (hasFoodNightlife && /^(?:light nightlife|nightlife|famous local food)$/.test(key)) {
      return false;
    }
    const budgetMatch = String(item || "").match(/\b(?:stay\s+under|under)\s+(?:₱|PHP\s*)?(\d{1,3}(?:,\d{3})*)\/night\b/i);
    if (budgetMatch) {
      const amountKey = budgetMatch[1].replace(/,/g, "");
      if (seenBudgetCaps.has(amountKey)) return false;
      seenBudgetCaps.add(amountKey);
    }
    return true;
  });
}

function normalizeIntakePlace(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalBoholBaseAreaForIntake(value = "") {
  const key = normalizeIntakePlace(value);
  if (!key) return "";
  if (/\btagbilaran\b/.test(key)) return "Tagbilaran City";
  if (/\bpanglao\b|\balona\b/.test(key)) return "Panglao / Alona Beach area";
  if (/\bdumaluan\b/.test(key)) return "Dumaluan Beach area";
  if (/\bdauis\b/.test(key)) return "Dauis";
  if (/\bloboc\b/.test(key)) return "Loboc";
  if (/\banda\b/.test(key)) return "Anda";
  return "";
}

function canonicalCamiguinBaseAreaForIntake(value = "") {
  const key = normalizeIntakePlace(value);
  if (!key) return "";
  if (/\bmambajao\b|\byumbing\b/.test(key)) return "Mambajao / Yumbing";
  if (/\bmahinog\b/.test(key)) return "Mahinog";
  if (/\bcatarman\b/.test(key)) return "Catarman";
  if (/\bsagay\b/.test(key)) return "Sagay";
  return "";
}

function canonicalKnownBaseAreaForIntake(value = "") {
  const key = normalizeIntakePlace(value);
  if (/\bsession\s+road\b/.test(key)) return "Session Road";
  if (/\bburnham\s+park\b|\bcity\s+park\b/.test(key)) return "Burnham Park / City Center";
  if (/\bmountain\s+district\b/.test(key)) return "Camp John Hay / Mines View area";
  if (/\bmines\s+view\b/.test(key)) return "Mines View / Outlook Drive area";
  if (/\bsanta\s+fe\b|\bsta\s+fe\b/.test(key)) return "Santa Fe, Bantayan Island";
  if (/\bbantayan\b/.test(key)) return "Bantayan Island";
  return canonicalBoholBaseAreaForIntake(value) || canonicalCamiguinBaseAreaForIntake(value) || canonicalSiquijorBaseAreaForIntake(value);
}

function isBantayanIntakeTrip(tripContext = {}, contextText = "") {
  const key = normalizeIntakePlace(
    [
      tripContext?.destination,
      tripContext?.subArea,
      tripContext?.baseArea,
      tripContext?.hotelArea,
      tripContext?.country,
      contextText,
    ].filter(Boolean).join(" ")
  );
  if (!key) return false;
  return /\bbantayan\b/.test(key) ||
    (/\bsanta\s+fe\b|\bsta\s+fe\b/.test(key) && /\b(?:cebu|philippines)\b/.test(key));
}

function canonicalSiquijorBaseAreaForIntake(value = "") {
  const key = normalizeIntakePlace(value);
  if (!key) return "";
  if (/\bsan\s+juan\b/.test(key)) return "San Juan";
  if (/\blarena\b/.test(key)) return "Larena";
  if (/\blazi\b/.test(key)) return "Lazi";
  if (/\bsiquijor\s+town\b|\bsiquijor\b/.test(key)) return "Siquijor town";
  return "";
}

function canonicalExplicitBaseSelectionForIntake(value = "") {
  const key = normalizeIntakePlace(value);
  if (!key) return "";
  if (/\b(?:hotel|resort|hostel|inn|guesthouse|guest house|cottages?|lodge|lodging|rooms?)\b/.test(key)) {
    return "";
  }
  const base = canonicalKnownBaseAreaForIntake(value);
  if (!base) return "";
  const baseKey = normalizeIntakePlace(base);
  const aliases = [
    "tagbilaran",
    "tagbilaran city",
    "panglao",
    "panglao alona",
    "panglao alona beach area",
    "alona",
    "alona beach",
    "dumaluan",
    "dauis",
    "loboc",
    "anda",
    "mambajao",
    "mambajao yumbing",
    "yumbing",
    "mahinog",
    "catarman",
    "sagay",
    "san juan",
    "larena",
    "lazi",
    "siquijor town",
    "santa fe",
    "sta fe",
    "santa fe bantayan island",
    "bantayan",
    "bantayan island",
  ];
  return aliases.includes(key) || key === baseKey ? base : "";
}

function cleanAccommodationSelectionNameForIntake(value = "") {
  return cleanTripFactValue(value)
    .replace(/^\s*(?:yes|yeah|yep|yup|sure|ok|okay|sige)\b[\s,.;:-]*/i, "")
    .replace(/^\s*(?:i\s*(?:'\s*ll|will)\s+stay\s+(?:here|at|in)|we'?ll\s+stay\s+(?:here|at|in)|i\s+will\s+use|we\s+will\s+use)\b[\s,.;:-]*/i, "")
    .replace(/\s+\b(?:yes|yeah|yep|yup|ok|okay|sige|sure)\b[\s\S]*$/i, "")
    .replace(/\b(?:yes|yeah|yep|yup|ok|okay|sige|sure)\b\s*,\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function looksLikeBareAccommodationSelectionForIntake(value = "") {
  const raw = cleanAccommodationSelectionNameForIntake(value);
  if (!raw) return false;
  if (/[?]/.test(raw)) return false;
  if (/\b(?:recommend|suggest|find|show|list|where|near|under|below|budget|cheap|affordable|book(?:ing)?|reserve|available|availability)\b/i.test(raw)) {
    return false;
  }
  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 7) return false;
  return /\b(?:hotel|resort|hostel|inn|guesthouse|guest\s+house|lodge|suites?|apart(?:el|ment)?|pension|villa)\b/i.test(raw);
}

function formatSelectedHotelBaseLabelForIntake(selectedHotel = "", baseArea = "") {
  const hotel = String(selectedHotel || "").trim();
  const base = String(baseArea || "")
    .trim()
    .replace(/^Baguio\s+(Session Road|Burnham Park|Camp John Hay|Mines View(?:\s+Park)?|Botanical Garden)$/i, "$1");
  if (!hotel) return base;
  if (!base) return hotel;

  const hotelKey = normalizeIntakePlace(hotel);
  const baseKey = normalizeIntakePlace(base);
  if (baseKey.includes(hotelKey)) return base;
  if (hotelKey === baseKey || hotelKey.includes(baseKey)) return hotel;

  if (/^(?:near|around|by)\b/i.test(base)) return `${hotel}, ${base}`;
  if (/\bsession road|main road|market|park|view|garden|city center|city centre|town proper|beach|port|station|pier|airport|terminal|area\b/i.test(base)) {
    return `${hotel}, near ${base}`;
  }
  return `${hotel}, ${base}`;
}

function isBaseAreaForCanonicalDestination(value = "", destination = "") {
  const destKey = normalizeIntakePlace(destination);
  if (/\bbohol\b/.test(destKey)) return Boolean(canonicalBoholBaseAreaForIntake(value));
  if (/\bcamiguin\b/.test(destKey)) return Boolean(canonicalCamiguinBaseAreaForIntake(value));
  if (/\bsiquijor\b/.test(destKey)) return Boolean(canonicalSiquijorBaseAreaForIntake(value));
  if (/\bcebu\b|\bbantayan\b/.test(destKey)) return Boolean(canonicalKnownBaseAreaForIntake(value));
  return false;
}

function getIntakeDestinationLabel(tripContext = {}) {
  const parts = [
    tripContext?.subArea,
    tripContext?.destination,
    tripContext?.country,
  ].map((v) => String(v || "").trim()).filter(Boolean);
  // Worldwide-safe dedupe: drop later parts whose normalized form duplicates
  // an earlier part. This prevents "Thailand, Thailand" when the user names
  // a country-only destination (destination='Thailand', country='Thailand')
  // and "Cebu, Cebu, Philippines" when the sub-area equals the destination.
  const seen = new Set();
  const deduped = [];
  for (const part of parts) {
    const key = part.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    // Also skip a token that is a substring of a previously-kept token, e.g.
    // skip "Cebu" if "Cebu City" already kept; skip "Thailand" if a more
    // specific "Bangkok, Thailand" already kept.
    if ([...seen].some((existing) => existing === key || existing.split(" ").includes(key))) continue;
    seen.add(key);
    deduped.push(part);
  }
  return deduped.join(", ") || "the destination";
}

function recentAssistantAlreadyShowedHighlights(recent = [], place = "") {
  const key = normalizeIntakePlace(place);
  if (!key) return false;
  return recent.some((m) => {
    if (m?.role !== "assistant") return false;
    const text = String(m.content || "");
    return /Highlights include:/i.test(text) && normalizeIntakePlace(text).includes(key);
  });
}

function latestUserIntroducesSpecificDestination(text = "", tripContext = {}) {
  const t = String(text || "").trim();
  if (!t) return false;
  const subArea = String(tripContext?.subArea || "").trim();
  const destination = String(tripContext?.destination || "").trim();
  const candidates = [subArea, destination].filter((v) => v && normalizeIntakePlace(v).length >= 3);
  if (!candidates.length) return false;
  return candidates.some((place) => {
    const escaped = place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b(?:go to|visit|trip to|travel to|take me to|want to go to|we want to go to)\\s+${escaped}\\b`, "i").test(t) ||
      new RegExp(`^\\s*${escaped}\\b(?:\\s+(?:for|in|on|with|from|by|,|\\d+\\s*days?))`, "i").test(t) ||
      new RegExp(`\\b${escaped}\\b\\s+(?:for\\s+\\d+\\s*days?|in\\s+[a-z]+\\s+\\d{1,2}|with\\s+(?:my\\s+)?(?:parents|family|friends|partner|kids))`, "i").test(t) ||
      normalizeIntakePlace(t) === normalizeIntakePlace(place);
  });
}

const KNOWN_DESTINATION_HIGHLIGHTS = [
  {
    match: /\bbaguio\b/,
    tripType: "a cool-weather city break",
    items: [
      ["Burnham Park", "a central, easy-paced stop for boating, biking, and relaxed family strolls."],
      ["Mines View Park", "a classic viewpoint for mountain scenery and quick souvenir browsing."],
      ["Baguio Botanical Garden", "a garden-focused stop that fits travelers who want a calmer pace."],
      ["Baguio Cathedral", "a city landmark with an easy Session Road pairing."],
      ["Baguio Public Market", "a practical place for strawberries, pasalubong, and local snack hunting."],
    ],
  },
  {
    match: /\btagaytay\b/,
    tripType: "a quick highland escape near Taal Lake",
    items: [
      ["Taal Volcano view deck", "the signature lake-and-volcano scenery that anchors most Tagaytay trips."],
      ["Picnic Grove", "a simple family-friendly stop for views, short walks, and easy photos."],
      ["People's Park in the Sky", "a higher viewpoint with cooler air and wide Tagaytay views."],
      ["Tierra de Maria", "a peaceful religious stop that pairs well with garden-style pacing."],
      ["Balay Dako", "a popular Filipino food stop for a sit-down meal with a view."],
    ],
  },
  {
    match: /\bcebu(?:\s+city)?\b/,
    tripType: "a compact history, food, and city-view trip",
    items: [
      ["Magellan's Cross", "a quick heritage anchor in downtown Cebu City."],
      ["Basilica Minore del Santo Nino", "the city's most important devotional site and a natural pair with Magellan's Cross."],
      ["Fort San Pedro", "a short heritage stop that keeps the old-city loop grounded."],
      ["Tops", "a classic hillside viewpoint for skyline views and cooler evening air."],
      ["Mactan Shrine", "a practical Mactan-side history stop before seafood or airport-area plans."],
    ],
  },
  {
    match: /\bmanila\b/,
    tripType: "a city break with strong heritage and food stops",
    items: [
      ["Intramuros", "the best base for Spanish-era walls, plazas, and walkable heritage."],
      ["San Agustin Church", "a UNESCO-listed church and one of Manila's strongest historic anchors."],
      ["Manila Cathedral", "a grand Catholic landmark that pairs naturally with Intramuros."],
      ["Rizal Park", "a spacious civic landmark for a slower outdoor stop."],
      ["Binondo", "a practical food-and-culture area for old Manila flavor."],
    ],
  },
  {
    match: /\bdavao\b/,
    tripType: "a relaxed city-and-nature trip",
    items: [
      ["Philippine Eagle Center", "a major conservation stop and one of Davao's strongest nature anchors."],
      ["People's Park", "an easy city stop for a relaxed walk and local orientation."],
      ["Eden Nature Park", "a cooler upland nature stop for families and slower pacing."],
      ["Roxas Night Market", "a popular evening food stop for simple local eats."],
      ["Samal Island", "the easiest beach add-on from Davao City."],
    ],
  },
  {
    match: /\bmakati\b/,
    tripType: "a polished city stay with food, shopping, and cafe stops",
    items: [
      ["Greenbelt", "a central dining, cafe, and shopping base with easy indoor-outdoor walks."],
      ["Ayala Museum", "a strong culture stop close to the main Makati malls."],
      ["Legazpi Active Park", "a calm pocket park near cafes and restaurants."],
      ["Salcedo Weekend Market", "a useful food stop when timing lines up with the market day."],
      ["Poblacion", "a lively evening area for restaurants, bars, and casual nightlife."],
    ],
  },
  {
    match: /\bpasay\b|\bmoa\b|\bmall\s+of\s+asia\b/,
    tripType: "a bayside mall, food, and entertainment stop",
    items: [
      ["SM Mall of Asia", "the main retail and dining anchor in Pasay's bay area."],
      ["MOA Seaside Boulevard", "a practical sunset-walk area beside the mall complex."],
      ["IKEA Pasay City", "a convenient landmark for shopping and casual food."],
      ["SM By the Bay Amusement Park", "an easy evening add-on when rides or bay views fit the plan."],
      ["National Shrine of Our Mother of Perpetual Help", "a major nearby religious landmark in Baclaran."],
    ],
  },
  {
    match: /\bbaler\b/,
    tripType: "a budget-friendly beach and nature trip",
    items: [
      ["Sabang Beach", "the main surf-and-sunrise beach anchor."],
      ["Ditumabo Mother Falls", "a strong nature stop for a waterfall side trip."],
      ["Ermita Hill", "a viewpoint with local history and coastal scenery."],
      ["Museo de Baler", "a compact heritage stop for local context."],
      ["Diguisit Beach", "a scenic coastal stop for rock formations and sunset timing."],
    ],
  },
  {
    match: /\bsiquijor\b/,
    tripType: "a slow island loop with beaches and inland nature",
    items: [
      ["Cambugahay Falls", "a famous blue-water waterfall stop for swimming and photos."],
      ["Salagdoong Beach", "a classic beach stop with clear-water scenery."],
      ["Paliton Beach", "a relaxed sunset beach near San Juan."],
      ["Lazi Church", "a heritage church that pairs well with the convent area."],
      ["Old Enchanted Balete Tree", "a quick, distinctive inland stop on a loop route."],
    ],
  },
  {
    match: /\bcamiguin\b/,
    tripType: "a compact island trip with volcano scenery and beaches",
    items: [
      ["White Island", "the signature sandbar stop with volcano views."],
      ["Sunken Cemetery", "a distinctive coastal landmark and photo stop."],
      ["Katibawasan Falls", "a tall waterfall stop that fits a nature loop."],
      ["Ardent Hot Spring", "a relaxed soak stop after sightseeing."],
      ["Mantigue Island", "a beach and snorkeling side trip when sea conditions are good."],
    ],
  },
  {
    match: /\bboracay\b/,
    tripType: "a beach-focused island escape",
    items: [
      ["White Beach", "the main powder-sand beach and sunset anchor."],
      ["Puka Shell Beach", "a quieter beach option away from the busiest stations."],
      ["Bulabog Beach", "the wind-sports side of the island and a good morning walk."],
      ["D'Mall Boracay", "a convenient food, shopping, and meetup base."],
      ["Willy's Rock", "a simple landmark stop along White Beach."],
    ],
  },
  {
    match: /\bbohol\b|\bpanglao\b/,
    tripType: "a nature, heritage, and beach trip",
    items: [
      ["Chocolate Hills", "the signature inland scenery and the strongest Bohol landmark."],
      ["Philippine Tarsier Sanctuary", "a key wildlife stop when handled at a quiet pace."],
      ["Loboc River", "a relaxed river stop that works well for families."],
      ["Baclayon Church", "a heritage church stop on the classic countryside route."],
      ["Alona Beach", "the main Panglao beach base for food, tours, and sunset."],
    ],
  },
  {
    match: /\bsiargao\b/,
    tripType: "a surf, lagoon, and island-hopping trip",
    items: [
      ["Cloud 9", "the iconic surf and boardwalk anchor in General Luna."],
      ["Sugba Lagoon", "a strong day-trip stop for turquoise water and paddling."],
      ["Magpupungko Rock Pools", "a tide-dependent natural pool stop."],
      ["Naked Island", "a classic island-hopping sandbar stop."],
      ["Maasin River", "a scenic inland stop for a quieter nature break."],
    ],
  },
  {
    match: /\bcoron\b/,
    tripType: "a lagoon, lake, and island-hopping trip",
    items: [
      ["Kayangan Lake", "one of Coron's signature lake-and-viewpoint stops."],
      ["Twin Lagoon", "a classic limestone lagoon stop with dramatic scenery."],
      ["Barracuda Lake", "a distinctive clear-water lake for swimming or diving."],
      ["Maquinit Hot Spring", "a useful evening soak after island hopping."],
      ["Mount Tapyas", "a sunset viewpoint over Coron town and the bay."],
    ],
  },
];

function findKnownDestinationHighlights(key = "") {
  return KNOWN_DESTINATION_HIGHLIGHTS.find((entry) => entry.match.test(String(key || ""))) || null;
}

function buildSpecificDestinationHighlightsSection(tripContext = {}) {
  const label = String(tripContext?.subArea || tripContext?.destination || "This destination").trim();
  const key = normalizeIntakePlace(label);
  if (/\bel nido\b/.test(key)) {
    return [
      `${label} is a strong choice for a short Palawan escape.`,
      "Highlights include:",
      "- **Big Lagoon:** the classic turquoise-lagoon stop and the most recognizable island-hopping view.",
      "- **Small Lagoon:** a tighter paddle-and-swim spot with calmer scenery.",
      "- **Secret Lagoon:** a hidden-feeling limestone pocket often included on island-hopping routes.",
      "- **Nacpan Beach:** a long, sandy beach for a slower reset outside town.",
      "- **Las Cabanas Beach:** one of the easiest sunset spots near the main base.",
      "",
      "Would you like me to add any of these to your itinerary?",
    ].join("\n");
  }

  const known = findKnownDestinationHighlights(key);
  if (known) {
    return [
      `${label} is a strong choice for ${known.tripType}.`,
      "Highlights include:",
      ...known.items.map(([name, note]) => `- **${name}:** ${note}`),
      "",
      "Would you like me to add any of these to your itinerary?",
    ].join("\n");
  }

  // If we do not have a reliable deterministic set, prefer the model's own
  // reply over injecting generic placeholders like "Signature attraction".
  // The PDF evaluation specifically flags those placeholders as a failure.
  return "";
}

function sanitizeBaseAreaLabel(rawLabel = "") {
  // Strip must-visit/special-request noise that sometimes leaks into the
  // destination label (e.g. "Chocolate Hills Too", "churches and famous foods").
  // The accommodation section must always recommend the BASE area, not a
  // day-trip attraction.
  let label = String(rawLabel || "").trim();
  if (!label) return label;
  label = label
    .replace(/\bChocolate\s+Hills\s+too\b/gi, "")
    .replace(/\b(?:and|also|plus)\s+visit\b[^,]*$/gi, "")
    .replace(/\b(?:churches?|famous foods?|food stops?|must[-\s]?try)\b[^,]*?(?=,|$)/gi, "")
    .replace(/\bvisit\s+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[,\s]+$/g, "")
    .replace(/^[,\s]+/g, "")
    .trim();
  return label || rawLabel;
}

function formatNightlyCapFromUserText(latestUser = "") {
  const capMatch = String(latestUser || "").match(/\b(?:under|below|less\s+than|max(?:imum)?|up\s+to)\s*((?:₱|php|p)?\s*\d+(?:[,.]\d+)?\s*(?:k|thousand)?)\s*(?:per\s*night|pernight|\/night|nightly|a\s+night)?\b/i);
  if (!capMatch) return "";
  const raw = String(capMatch[1] || "").replace(/\s+/g, "");
  const numericMatch = raw.match(/(\d+(?:[,.]\d+)?)(k|thousand)?/i);
  if (!numericMatch) return raw.replace(/^p/i, "₱").replace(/^php/i, "PHP ");
  const amount = Number(String(numericMatch[1]).replace(/[,.]/g, ""));
  const value = Number.isFinite(amount) && amount > 0
    ? amount * (numericMatch[2] ? 1000 : 1)
    : 0;
  return value ? `PHP ${Math.round(value).toLocaleString("en-US")}` : raw.replace(/^p/i, "₱").replace(/^php/i, "PHP ");
}

function parseNightlyAmountToken(token = "", neighborToken = "") {
  const raw = String(token || "").replace(/\s+/g, "").toLowerCase();
  const neighbor = String(neighborToken || "").replace(/\s+/g, "").toLowerCase();
  const match = raw.match(/(\d+(?:[,.]\d+)?)(k|thousand)?/i);
  if (!match) return 0;
  const amount = Number(String(match[1]).replace(/[,.]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const hasK = Boolean(match[2]) || /\b(?:k|thousand)\b/i.test(neighbor);
  return Math.round(amount * (hasK ? 1000 : 1));
}

function formatNightlyRangeFromUserText(latestUser = "") {
  const text = String(latestUser || "");
  const rangeMatch = text.match(
    /\b(?:₱|php|p)?\s*(\d+(?:[,.]\d+)?)\s*(k|thousand)?\s*(?:-|–|to)\s*(?:₱|php|p)?\s*(\d+(?:[,.]\d+)?)\s*(k|thousand)?\s*(?:per\s*night|pernight|\/night|nightly|a\s+night)?\b/i
  );
  if (!rangeMatch) return "";
  const highSuffix = rangeMatch[4] || rangeMatch[2] || "";
  let low = parseNightlyAmountToken(rangeMatch[1], rangeMatch[2] || highSuffix);
  const high = parseNightlyAmountToken(rangeMatch[3], highSuffix);
  if (low > 0 && low < 100 && high >= 1000) low *= 1000;
  if (!low || !high || high < low) return "";
  return `PHP ${low.toLocaleString("en-US")}–${high.toLocaleString("en-US")}`;
}

function formatNightlyBudgetPhraseFromUserText(latestUser = "") {
  const range = formatNightlyRangeFromUserText(latestUser);
  if (range) return `around ${range}/night`;
  const cap = formatNightlyCapFromUserText(latestUser);
  if (!cap) return "";
  const saysUnder = /\b(?:under|below|less\s+than|max(?:imum)?|up\s+to)\b/i.test(String(latestUser || ""));
  return `${saysUnder ? "under" : "around"} ${cap}/night`;
}

function shouldPersistNightlyCapAsSpecialRequest(text = "") {
  const raw = String(text || "").trim();
  if (!raw || !formatNightlyCapFromUserText(raw)) return false;
  if (latestUserRequestsAccommodationRecommendations(raw)) return false;
  if (/\b(?:recommend|suggest|list|show|find|where\s+to\s+stay|places?\s+to\s+stay)\b/i.test(raw)) return false;
  return /\b(?:include|add|make\s+sure|keep|use|set|hotel\s+budget|accommodation\s+budget|stay\s+under|base\s+under|place\s+to\s+stay\s+under|lodging\s+under)\b/i.test(raw);
}

function latestUserWantsNamedStayOptions(text = "") {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  if (formatNightlyRangeFromUserText(t) && latestUserRequestsAccommodationRecommendations(t)) return true;
  return /\b(?:hotel|hotels|hostel|hostels|guesthouse|guesthouses|inn|inns|cottages?|resort|resorts|find|list|show)\b/i.test(t) ||
    /\b(?:under|below|less\s+than|max(?:imum)?|up\s+to)\s*(?:₱|php|p)?\s*\d/i.test(t);
}

function safeAccommodationDestinationLabel(label = "", tripContext = {}) {
  const canonical = formatIntakeDestination(tripContext);
  const raw = sanitizeBaseAreaLabel(label || canonical || "");
  const key = normalizeIntakePlace(raw);
  if (activeStayDestinationKey(tripContext) === "bantayan") {
    const baseKey = normalizeIntakePlace(String(tripContext?.baseArea || tripContext?.subArea || ""));
    if (/\bsanta\s+fe\b|\bsta\s+fe\b/.test(`${key} ${baseKey}`)) return "Santa Fe, Bantayan Island";
    return "Bantayan Island, Philippines";
  }
  const invalidKey = !key || /^(?:stay|stays|stay philippines|me a|me a philippines|hotel|hotels|hotel philippines|place|places|base|recommendation|philippines)$/i.test(key);
  if (invalidKey) {
    const canonicalKey = normalizeIntakePlace(canonical);
    const canonicalInvalid = !canonicalKey || /^(?:stay|stays|stay philippines|me a|me a philippines|hotel|hotels|hotel philippines|place|places|base|recommendation|philippines)$/i.test(canonicalKey);
    return canonicalInvalid ? "the active destination" : canonical;
  }
  if (/\bcamiguin\b/.test(key)) return "Camiguin, Philippines";
  if (/\bbohol\b/.test(key)) return "Bohol, Philippines";
  if (/\bsiquijor\b/.test(key)) return "Siquijor, Philippines";
  return raw;
}

function buildSiquijorNamedStayOptions(tripContext = {}, budgetPhrase = "") {
  const base = String(tripContext?.baseArea || tripContext?.subArea || "").trim();
  const baseKey = normalizeIntakePlace(base);
  const baseLabel = /\bsan\s+juan\b/.test(baseKey)
    ? "San Juan"
    : /\blarena\b/.test(baseKey)
    ? "Larena / nearby Siquijor"
    : /\blazi\b/.test(baseKey)
    ? "Lazi / nearby Siquijor"
    : /\bsiquijor\s+town\b|\bsiquijor\b/.test(baseKey)
    ? "Siquijor town / nearby San Juan"
    : "San Juan / nearby Siquijor";
  const heading = budgetPhrase
    ? `**${baseLabel} stays to check ${budgetPhrase} per room:**`
    : `**${baseLabel} stays to check:**`;
  return [
    heading,
    "- **Fable Hostel:** social budget stay around San Juan; dorms and simple rooms can fit tighter budgets depending on date.",
    "- **Tori's Backpackers Paradise:** low-cost beachfront/backpacker option in San Juan; good for solo budget travelers who want food and beach access nearby.",
    "- **Tagbalayon Lodging House:** practical San Juan-area lodging to compare for simple rooms and easy island-loop access.",
    "- **The Bruce Resort budget room types:** more polished than the cheapest hostels; check promos because some dates may exceed a strict cap.",
    "- **Siquijor Eastern Garan Seaview Resort:** quieter option away from the busiest strip; compare transfer time if you want San Juan nightlife.",
    "",
    "San Juan is the practical base I’d use first for beaches, food, scooter rentals, and nightlife access. Live rates change by date and booking platform, so verify before choosing. TravelMate does not book rooms.",
  ].join("\n");
}

function buildCamiguinNamedStayOptions(tripContext = {}, budgetPhrase = "") {
  const base = String(tripContext?.baseArea || tripContext?.subArea || "").trim();
  const baseKey = normalizeIntakePlace(base);
  const isMahinog = /\bmahinog\b/.test(baseKey);
  const isMambajao = /\bmambajao\b|\byumbing\b/.test(baseKey);
  const isCatarman = /\bcatarman\b/.test(baseKey);
  const isSagay = /\bsagay\b/.test(baseKey);
  const baseLabel = isMahinog
    ? "Mahinog / nearby Camiguin"
    : isCatarman
    ? "Catarman / nearby Camiguin"
    : isSagay
    ? "Sagay / nearby Camiguin"
    : isMambajao
    ? "Mambajao / Yumbing"
    : "Camiguin";
  const heading = budgetPhrase
    ? `**${baseLabel} stays to check ${budgetPhrase} per room:**`
    : `**${baseLabel} stays to check:**`;
  const inventoryNote = isMahinog
    ? [
        "Mahinog has fewer budget-range tourist stays than Mambajao / Yumbing. The best practical options are usually in Mambajao / Yumbing, about 25–35 minutes away by local transport depending on traffic and pickup point.",
        "",
      ]
    : isCatarman || isSagay
    ? [
        `${baseLabel.split(" / ")[0]} has a smaller stay inventory, so compare nearby local inns first, then check Mambajao / Yumbing if you want more food and tour-access options.`,
        "",
      ]
    : [];
  return [
    heading,
    ...inventoryNote,
    "- **GV Hotel Camiguin:** usually a budget-friendly practical option around Mambajao; simple and central, but verify current room rates.",
    "- **Pabua's Cottages:** basic cottages near the Yumbing tourist loop; some room types may fit tighter caps depending on date.",
    "- **Camiguin Volcan Beach Eco Resort:** may have lower-rate room types or promos; check current prices before deciding.",
    "- **Paras Beach Resort:** often higher than a strict budget cap, but older room types or promos may come close on some dates.",
    "- **Nouveau Resort:** generally more polished and often above budget; only consider it if you find a promo that fits.",
    "",
    "Mambajao / Yumbing is the practical base to search first because it keeps food, White Island access, rentals, waterfalls, hot springs, and common tour routes close.",
    "Live rates change by date and booking platform, so verify before choosing. TravelMate does not book rooms.",
  ].join("\n");
}

function buildBoholNamedStayOptions(tripContext = {}, budgetPhrase = "") {
  const base = String(tripContext?.baseArea || tripContext?.subArea || "").trim();
  const baseKey = normalizeIntakePlace(base);
  const isTagbilaran = /tagbilaran/.test(baseKey);
  const isPanglao = /panglao|alona|dumaluan|dauis/.test(baseKey);
  const isLoboc = /loboc/.test(baseKey);
  const isAnda = /anda/.test(baseKey);
  // No silent Panglao default. If we cannot tell which base the user picked,
  // ask instead of inventing a list — picking Panglao silently was the
  // previous bug (Tagbilaran answers got Panglao stays back).
  if (!isTagbilaran && !isPanglao && !isLoboc && !isAnda) {
    return [
      "**Bohol stays — which base should I search?**",
      "I need to know your base area before I can give specific stay names — different parts of Bohol have very different stay profiles.",
      "- **Tagbilaran City:** practical city base near the ferry port and city food.",
      "- **Panglao / Alona Beach:** beachfront and tour-pickup hub.",
      "- **Loboc:** river/countryside vibe, quieter pace.",
      "- **Anda:** beach-quiet far east, fewer crowds.",
      "Tell me the area and I'll list specific named stays" + (budgetPhrase ? ` to check ${budgetPhrase}.` : "."),
    ].join("\n");
  }
  const baseLabel = isTagbilaran
    ? "Tagbilaran City"
    : isPanglao
    ? "Panglao / Alona area"
    : isLoboc
    ? "Loboc"
    : "Anda";
  const heading = budgetPhrase
    ? `**${baseLabel} stays to check ${budgetPhrase} per room:**`
    : `**${baseLabel} stays to check:**`;
  const options = isTagbilaran
    ? [
        "- **717 Cesar Place Hotel:** practical city option to check near Tagbilaran routes; rates vary by date.",
        "- **Travelbee Seaside Inn:** simple Tagbilaran stay option to compare for ferry access and city meals.",
        "- **Belian Hotel:** convenient near Tagbilaran port; may sit near or above budget depending on date.",
      ]
    : isPanglao
    ? [
        "- **Greenfields Tourist Inn:** budget-leaning Panglao option to check near the Alona side of the island.",
        "- **Panglao Regents Park Resort:** often mid-range; check promo rooms if you are holding a nightly cap.",
        "- **Alona Pawikan:** smaller stay option near Alona to compare for simple rooms and walkability.",
      ]
    : isLoboc
    ? [
        "- **Loboc River Resort:** riverside cottages near the cruise dock; relaxed nature pace.",
        "- **Fox & Firefly Cottages:** small eco-style stay near the Loboc River.",
        "- **Nuts Huts Bohol:** simple riverside cabins for nature-leaning travelers; check rates by season.",
      ]
    : [
        "- **Anda White Beach Resort:** beachfront base on the quieter Anda coast.",
        "- **Quinale Beach guesthouses:** simple local inns along Quinale; great for a slow pace.",
        "- **Coco Loco Beach Resort Anda:** modest beach-side option; verify current pricing.",
      ];
  return [
    heading,
    ...options,
    "",
    "Live nightly rates vary by date and platform, so verify before deciding. TravelMate does not book rooms.",
  ].join("\n");
}

function activeStayDestinationKey(tripContext = {}) {
  const destination = formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext);
  const key = normalizeIntakePlace(destination);
  const baseKey = normalizeIntakePlace(String(tripContext?.baseArea || tripContext?.subArea || ""));
  const combined = `${key} ${baseKey}`.trim();
  if (/\bcamiguin\b/.test(combined)) return "camiguin";
  if (/\bbohol\b|\bpanglao\b|\btagbilaran\b|\balona\b|\bdauis\b|\bdumaluan\b/.test(combined)) return "bohol";
  if (/\bsiquijor\b|\bsan\s+juan\b|\blarena\b|\blazi\b/.test(combined)) return "siquijor";
  if (/\bbantayan\b|\bsanta\s+fe\b|\bsta\s+fe\b/.test(combined)) return "bantayan";
  if (/\bcebu\b/.test(combined)) return "cebu";
  if (/\bmanila\b/.test(combined)) return "manila";
  if (/\bbaguio\b/.test(combined)) return "baguio";
  if (/\bel nido\b/.test(combined)) return "el nido";
  return key.split(" ")[0] || "";
}

function accommodationReplyDestinationMismatch(reply = "", tripContext = {}) {
  const text = String(reply || "");
  if (!text.trim() || !replyHasAccommodationSuggestionList(text)) return false;
  const active = activeStayDestinationKey(tripContext);
  if (!active) return false;
  if (/\b(?:Stay|Me A|Caniguin|Camuguin)\s*,\s*Philippines\b/i.test(text)) return true;
  const mentionsBohol = /\bbohol\b/i.test(text);
  const mentionsCamiguin = /\bcamiguin\b/i.test(text);
  const mentionsCebuStay =
    /\bcebu(?:\s+city)?\s+(?:stays|stay options|hotels|hostels|guesthouses|inns)\b/i.test(text) ||
    /\b(?:hotels?|hostels?|guesthouses?|inns)\s+(?:in|near)\s+cebu(?:\s+city)?\b/i.test(text);
  if (active === "camiguin" && mentionsBohol) return true;
  if (active === "bohol" && mentionsCamiguin) return true;
  if ((active === "camiguin" || active === "bohol") && mentionsCebuStay) return true;
  return false;
}

function staticAccommodationRecommendationsEnabled() {
  // Static named-stay lists were useful as an early fallback, but they read
  // as hardcoded/canned recommendations and can go stale. Keep live-search
  // filter guidance as the only deterministic accommodation path.
  return false;
}

function buildProviderFirstAccommodationGuidance({ label = "", heading = "", tripContext = {}, latestUser = "" } = {}) {
  const destination = String(label || "the destination").trim();
  const base = String(tripContext?.baseArea || tripContext?.hotelArea || tripContext?.subArea || "").trim();
  const budgetPhrase = formatNightlyBudgetPhraseFromUserText(latestUser) || String(tripContext?.accommodationBudget || "").trim();
  const cap = formatNightlyCapFromUserText(latestUser);
  const budgetLabel = budgetPhrase || (cap ? `under ${cap}/night` : "");
  const baseLine = base
    ? `Use **${base}** as the working search area for this trip.`
    : `Start with the most practical central/arrival-area base in **${destination}**, then compare live listings before choosing.`;
  const budgetLine = budgetLabel
    ? `Filter live listings to **${budgetLabel} per room**, then check taxes, fees, cancellation rules, recent reviews, and exact map distance.`
    : "Compare live nightly rates, fees, reviews, cancellation rules, and exact map distance before deciding.";
  return [
    heading || `**${destination} stay/base live-search filters:**`,
    baseLine,
    "- **Area filters:** town proper / beach side / quieter nearby barangay, depending on what the booking app offers.",
    "- **Property filters:** pension house, small inn, apartment/studio, guesthouse, or simple resort.",
    "- **Room filters:** private room for your party size, aircon if needed, private bathroom, and free cancellation if available.",
    "- **Sort/check:** sort by total price first, then verify recent photos, newest reviews, and walking/tricycle distance.",
    budgetLine,
    "Use map search, Agoda, Booking.com, Traveloka, or your preferred booking platform for current names, availability, and rates. TravelMate does not book rooms.",
  ].join("\n");
}

function buildAccommodationRecommendationSection(tripContext = {}, latestUser = "") {
  const rawLabel = getIntakeDestinationLabel(tripContext);
  const label = safeAccommodationDestinationLabel(rawLabel, tripContext);
  const activeKey = activeStayDestinationKey(tripContext);
  const key = activeKey || normalizeIntakePlace(label);
  const cap = formatNightlyCapFromUserText(latestUser);
  const budgetPhrase = formatNightlyBudgetPhraseFromUserText(latestUser) || String(tripContext?.accommodationBudget || "").trim();
  const wantsNamedOptions = latestUserWantsNamedStayOptions(latestUser);
  const heading = budgetPhrase
    ? `**${label} stays/base areas to check ${budgetPhrase} per room:**`
    : `**${label} stay/base recommendation:**`;

  if (!staticAccommodationRecommendationsEnabled()) {
    return buildProviderFirstAccommodationGuidance({ label, heading, tripContext, latestUser });
  }

  if (/\bel nido\b/.test(key)) {
    return [
      heading,
      "- **Spin Designer Hostel:** often a good-value social hostel near town; private rooms can vary, but dorms usually fit tighter budgets.",
      "- **Frendz Hostel El Nido:** lively, central, and useful for friends who want easy nightlife access; prices vary by room type and date.",
      "- **Happiness Hostel El Nido:** central hostel option near restaurants and tour desks; check platform rates because private rooms can climb.",
      "- **Austria's Guest House:** simple budget guesthouse style near the town core; best for no-frills sleeping and quick tour access.",
      "- **Cliffside Cottages:** basic budget stay with a quieter feel; check recent reviews and exact nightly rates before booking.",
    ].join("\n");
  }

  if (/\bcamiguin\b|\bmambajao\b|\byumbing\b|\bmahinog\b|\bcatarman\b|\bsagay\b/.test(key)) {
    if (wantsNamedOptions || cap || budgetPhrase) return buildCamiguinNamedStayOptions(tripContext, budgetPhrase);
    return [
      heading,
      "- **Mambajao / Yumbing:** best all-around base for first-time visitors and friends; keeps food, White Island access, scooter/van rentals, waterfalls, hot springs, and common tour routes close.",
      "- **Mahinog:** quieter and useful for port access; good when arrival/departure logistics matter more than nightlife or beach access.",
      "- **Catarman:** practical for northern sights like Sunken Cemetery, Old Church Ruins, Tuasan Falls, and hot springs.",
      "- **Sagay:** more local and quieter; better for a slower Camiguin pace away from the busiest visitor strip.",
      "",
      "Live nightly rates vary by date and platform, so verify before deciding.",
    ].join("\n");
  }

  if (/\bsiquijor\b|\bsan\s+juan\b|\blarena\b|\blazi\b/.test(key)) {
    if (wantsNamedOptions || cap || /\b(?:cheapest|cheap|cozy|cosy|budget)\b/i.test(latestUser)) {
      return buildSiquijorNamedStayOptions(tripContext, budgetPhrase);
    }
    return [
      heading,
      "- **San Juan:** best all-around base for first-time Siquijor trips, especially beaches, food, scooter rentals, sunsets, and nightlife.",
      "- **Siquijor town:** practical for port access and a quieter arrival/departure rhythm.",
      "- **Larena:** useful for northern/eastern loops and quieter stays.",
      "- **Lazi:** closer to Cambugahay Falls and heritage stops, but farther from the main San Juan food/nightlife strip.",
      "",
      "For a solo budget trip with beaches, churches, and motorbike routing, I’d use **San Juan**.",
    ].join("\n");
  }

  if (/\b(?:panglao|bohol|tagbilaran|alona|dauis|dumaluan|loboc|anda)\b/.test(key)) {
    if (wantsNamedOptions || cap || budgetPhrase) return buildBoholNamedStayOptions(tripContext, budgetPhrase);
    // Pick the area shortlist based on the user's actual sub-area instead
    // of defaulting to Panglao. If the user named Tagbilaran/Loboc/Anda,
    // surface that area first instead of leading with Panglao.
    const baseKey = normalizeIntakePlace(
      String(tripContext.baseArea || tripContext.subArea || "").trim()
    );
    if (/tagbilaran/.test(baseKey)) {
      return [
        heading,
        "- **Tagbilaran City center:** practical city base near the ferry port, transit, and food spots — easiest for first-time families.",
        "- **CPG Avenue / Island City Mall area:** convenient for quick meals, transport, and city access.",
        "- **Near Tagbilaran City Port:** good for tight ferry schedules and short stays.",
        "",
        "Live nightly rates vary by date and platform, so verify before deciding.",
      ].join("\n");
    }
    if (/loboc/.test(baseKey)) {
      return [
        heading,
        "- **Loboc riverside:** quiet, nature-leaning, close to the river cruise dock.",
        "- **Loboc town center:** simple inns near the church and main road.",
        "- **Nearby Sevilla / Bilar:** countryside base for an even slower pace.",
        "",
        "Live nightly rates vary by date and platform, so verify before deciding.",
      ].join("\n");
    }
    if (/anda/.test(baseKey)) {
      return [
        heading,
        "- **Quinale Beach front (Anda):** quieter beach base with white-sand stretch.",
        "- **Anda town proper:** small inns near food and basic transport.",
        "- **Eastern Bohol countryside (Anda outskirts):** for travelers who want a slow, rural pace.",
        "",
        "Live nightly rates vary by date and platform, so verify before deciding.",
      ].join("\n");
    }
    if (/panglao|alona|dumaluan|dauis/.test(baseKey)) {
      return [
        heading,
        "- **Panglao / Alona Beach area:** central for restaurants, beach time, and island/inland tour pickup — easiest base for families.",
        "- **Dumaluan Beach area:** quieter, family-friendly beach base a bit south of Alona — better for a slower pace.",
        "- **Dauis / Panglao town:** often more practical and budget-friendly, with simple inns and easier transfers.",
        "",
        "Live nightly rates vary by date and platform, so verify before deciding.",
      ].join("\n");
    }
    // Destination is Bohol but the user has not picked a sub-area yet.
    // Ask, don't pick Panglao silently.
    return [
      `**Which Bohol base do you want?**`,
      "Different parts of Bohol have very different stay profiles — tell me the area and I'll list specific named stays.",
      "- **Tagbilaran City:** practical city base near the ferry port and food.",
      "- **Panglao / Alona Beach:** beachfront and tour-pickup hub.",
      "- **Loboc:** river/countryside vibe, quieter pace.",
      "- **Anda:** beach-quiet far east, fewer crowds.",
    ].join("\n");
  }

  if (/\bbantayan\b|\bsanta\s+fe\b|\bsta\s+fe\b/.test(key)) {
    return [
      heading,
      "- **Solsken Guest House:** simple, quieter budget guesthouse near Santa Fe town and beach access.",
      "- **Myrna's Pension House:** practical budget option near Santa Fe town center.",
      "- **Edsan Apartment:** cheap, spacious apartment-style stay good for couples.",
      "- **Nanette's Tourist Inn:** budget-friendly inn in the Santa Fe / Pooc area.",
      "- **Budyong Beach Resort / Yooneek Beach Resort:** closer to beachfront if you can stretch above the budget cap.",
      "",
      "I'd use **Santa Fe town center / near Kota Beach** as your base — closest to beach, food, tricycle access, and the port.",
      "",
      "Live nightly rates vary by date and platform, so verify on Agoda, Booking.com, Traveloka, or map search before deciding. TravelMate does not book rooms.",
    ].join("\n");
  }

  if (/\bcebu(?:\s+city)?\b/.test(key)) {
    return [
      heading,
      "- **IT Park / Lahug area:** central, transit-friendly, and walkable to restaurants and cafes.",
      "- **Cebu Business Park / Ayala area:** convenient for malls, food, and easy taxi/Grab access.",
      "- **Mabolo / Capitol area:** practical for short stays close to the downtown heritage stops.",
      "",
      "Live nightly rates vary by date and platform — please verify before deciding.",
    ].join("\n");
  }

  if (/\bmanila\b/.test(key)) {
    return [
      heading,
      "- **Intramuros / Ermita area:** central for heritage walks and easy access to old Manila stops.",
      "- **Malate area:** practical for budget rooms with food, transit, and bay-area access nearby.",
      "- **Makati CBD:** safer-feeling base with strong transit and walkable food options.",
      "",
      "Live nightly rates vary by date and platform — please verify before deciding.",
    ].join("\n");
  }

  return [
    `**${label || "Destination"} stay/base search guidance:**`,
    "Use the most central neighborhood or arrival-area base in your trip summary, then compare named budget inns, cottages, guesthouses, hostels, and simple hotels on your preferred booking platform or map search.",
    "",
    "Live nightly rates vary by date and platform, so verify before deciding. TravelMate does not book rooms.",
  ].join("\n");
}

function appendRecommendationNextStep(reply = "", tripContext = {}) {
  const text = String(reply || "").trim();
  if (!text) return text;
  if (/\bWant me to (?:build the trip summary now|add this to the plan)\?|Want to pick one and continue\?|Should I generate\b/i.test(text)) {
    return text;
  }
  const coreEssentialsKnown = Boolean(
    (tripContext?.destination || tripContext?.subArea) &&
    tripContext?.days &&
    tripContext?.date &&
    tripContext?.travelers &&
    tripContext?.budget &&
    tripContext?.origin &&
    tripContext?.startTime &&
    tripContext?.transportMode &&
    (tripContext?.baseArea || tripContext?.noHotelYet === true)
  );
  if (coreEssentialsKnown) return text;

  const hasTripShape = Boolean(
    (tripContext?.destination || tripContext?.subArea || tripContext?.country) &&
    (tripContext?.days || tripContext?.date || tripContext?.travelers || tripContext?.budget || tripContext?.origin)
  );
  const prompt = hasTripShape
    ? "Want me to build the trip summary now?"
    : "Want to pick one and continue?";
  return `${text}\n\n${prompt}`;
}

function appendBlueprintIfSetupCompletedAfterRecommendation({
  normalizedParsed = {},
  recent = [],
  latestUser = "",
  sections = [],
} = {}) {
  const tripContext = normalizedParsed.tripContext || {};
  const cleanSections = (sections || []).filter(Boolean);
  const should = shouldAppendBlueprintAfterAccommodationRecommendation(tripContext, recent, latestUser);
  console.log("[intake] appendBlueprintIfSetupCompletedAfterRecommendation", {
    should,
    sectionsIn: cleanSections.length,
    essentialsComplete: tripContext.essentialsComplete,
    base: tripContext.baseArea || (tripContext.noHotelYet ? "noHotelYet" : null),
  });
  if (!should) {
    return cleanSections;
  }
  return [
    ...cleanSections,
    buildCanonicalIntakeBlueprintReply(
      { ...normalizedParsed, pendingEdits: [] },
      recent
    ),
  ];
}

function buildProviderAccommodationBullet(place = {}, baseLabel = "") {
  const name = String(place?.name || "").trim();
  if (!name) return "";
  const address = String(place?.address || place?.location || "").trim();
  const rating = Number.isFinite(Number(place?.rating)) && Number(place.rating) > 0
    ? `; listed rating ${Number(place.rating).toFixed(1)}`
    : "";
  const areaNote = baseLabel
    ? `near ${baseLabel}`
    : "near the active trip area";
  const locationNote = address
    ? `provider-listed around ${address.split(",").slice(0, 2).join(", ").trim()}`
    : `provider-listed ${areaNote}`;
  return `- **${name}:** ${locationNote}${rating}; check current room type, total fees, and map distance before deciding.`;
}

function distanceKmBetween(a = {}, b = {}) {
  const lat1 = Number(a?.lat);
  const lon1 = Number(a?.lng ?? a?.lon);
  const lat2 = Number(b?.lat);
  const lon2 = Number(b?.lng ?? b?.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function isBaguioAccommodationProviderResult(place = {}, baguioCenter = null) {
  const countryCode = String(
    place?.country_code ||
    place?.countryCode ||
    place?.address_components?.country_code ||
    place?.addressComponents?.countryCode ||
    ""
  ).trim().toLowerCase();
  if (countryCode && countryCode !== "ph") return false;

  const country = String(
    place?.country ||
    place?.address_components?.country ||
    place?.addressComponents?.country ||
    ""
  ).trim();
  if (country && !/^philippines$/i.test(country)) return false;

  const text = [
    place?.name,
    place?.address,
    place?.location,
    place?.city,
    place?.town,
    place?.municipality,
    place?.county,
    place?.state,
    place?.region,
    place?.province,
  ].map((value) => String(value || "")).join(" ");

  if (/\b(?:united\s+kingdom|england|devon|cornwall|plymouth|sutton\s+harbour|mount\s+batten|welbeck|liscawen|langdon)\b/i.test(text)) {
    return false;
  }

  const explicitLocalText = /\b(?:baguio|benguet|session\s+road|burnham|camp\s+john\s+hay|legarda|kisad|gov\.?\s*pack|upper\s+session|lower\s+session)\b/i.test(text);
  const hasAnyAddress = Boolean(String(place?.address || place?.location || "").trim());
  const point =
    place?.location && Number.isFinite(Number(place.location.lat)) && Number.isFinite(Number(place.location.lng))
      ? place.location
      : { lat: place?.lat, lng: place?.lng };
  const distanceKm = baguioCenter ? distanceKmBetween(point, baguioCenter) : null;

  if (distanceKm != null && distanceKm > 30) return false;
  if (hasAnyAddress && !explicitLocalText && distanceKm == null) return false;
  return explicitLocalText || distanceKm == null || distanceKm <= 30;
}

async function filterBaguioAccommodationProviderResults(places = [], area = "", appContext = {}) {
  const list = Array.isArray(places) ? places : [];
  if (!/\bbaguio\b/i.test(String(area || ""))) return list;

  let baguioCenter = null;
  try {
    baguioCenter = await geocodeArea("Baguio, Benguet, Philippines", {
      providerTimeoutMs: 8000,
      radiusMeters: 30000,
      timeZone: String(appContext?.timezone || "").trim() || "",
    });
  } catch (error) {
    console.warn("[Itinerary] accommodation Baguio geocode failed:", String(error?.message || error || ""));
  }

  const filtered = list.filter((place) => isBaguioAccommodationProviderResult(place, baguioCenter));
  const dropped = list.length - filtered.length;
  console.log(`[Itinerary] accommodation provider results filtered: dropped ${dropped} non-PH or non-Baguio entries.`);
  return filtered;
}

async function buildProviderBackedAccommodationRecommendationSection({
  tripContext = {},
  latestUser = "",
  appContext = {},
} = {}) {
  // Worldwide-safe short-circuit: skip the entire accommodation lookup when
  // the user has already told us they have their own place / it's a local
  // trip / they live in the destination / they explicitly said "no need".
  // Without this, the downstream pipeline runs a free geocoder hotel search for
  // whatever destination is currently locked — which has produced Italian
  // hotel lists in past sessions when the destination was wrongly extracted.
  const explicitlyNoStay =
    tripContext?.hasOwnPlace === true ||
    tripContext?.hotelStatus === "user_has_own" ||
    tripContext?.baseStatus === "none" ||
    /\b(?:i|we)\s+(?:have|own|got|already\s+have|already\s+got)\s+(?:a\s+|an\s+|my\s+|our\s+|the\s+)?(?:house|home|condo|apartment|flat|place|room|villa|cottage|unit|airbnb|booked\s+stay|hotel|stay|accommodation)\b/i.test(String(latestUser || "")) ||
    /\b(?:no\s+need|don'?t\s+need|do\s+not\s+need|skip)\b[^.\n]{0,40}\b(?:hotel|stay|accommodation|base|place\s+to\s+stay)\b/i.test(String(latestUser || "")) ||
    /\b(?:local\s+trip|staycation|day\s+trip|home(?:[-\s])?based|i'?m\s+local)\b/i.test(String(latestUser || ""));
  if (explicitlyNoStay) {
    console.log("[Itinerary] accommodation lookup skipped: user has own place / local trip");
    return "";
  }

  const destination = safeAccommodationDestinationLabel(getIntakeDestinationLabel(tripContext), tripContext);
  const base = sanitizeBaseAreaLabel(
    String(tripContext?.baseArea || tripContext?.hotelArea || tripContext?.subArea || destination || "").trim()
  );
  const area = base || destination;
  if (!area || /^the active destination$/i.test(area)) return "";

  try {
    const budgetPhrase = formatNightlyBudgetPhraseFromUserText(latestUser) || formatNightlyCapFromUserText(latestUser);
    const heading = budgetPhrase
      ? `**${destination} stays/base areas to check ${budgetPhrase} per room:**`
      : `**${destination} stay/base recommendation:**`;
    const isBaguioAccommodation = /\bbaguio\b/i.test(`${destination} ${area}`);
    const query = `hotels guesthouses inns near ${area}`;
    let places = await searchTextPlaces(query, {
      textQuery: query,
      areaHint: area,
      includedType: "hotel",
      maxResultCount: 5,
      allowPlaceSearch: true,
      timeZone: String(appContext?.timezone || "").trim() || "",
      currencyHint: "PHP",
      radiusMeters: 12000,
    });
    places = await filterBaguioAccommodationProviderResults(places, `${destination} ${area}`, appContext);
    if (isBaguioAccommodation && places.length < 2) {
      return "";
    }
    const unique = [];
    const seen = new Set();
    // Reject obviously non-accommodation results. Provider hotel queries
    // sometimes return motor shops, pharmacies, universities, schools,
    // banks, churches, malls, etc. — none of which are places to stay.
    // The blacklist catches names; the whitelist whitelists ambiguous
    // ones (e.g. "Park Inn", "Apartment 123") that contain a generic
    // accommodation noun.
    const ACCOMMODATION_BLACKLIST_RX =
      /\b(?:tattoo|tattoo\s+studio|tattoo\s+parlor|tattoo\s+shop|piercing|ink\s+studio|barber|barbershop|salon|beauty\s+parlor|nail\s+salon|massage\s+parlor|spa\s+clinic|gym|fitness|crossfit|yoga\s+studio|dive\s+shop|dive\s+center|dive\s+school|surf\s+shop|surf\s+school|surf\s+camp|surf\s+lesson|yamaha|honda|suzuki|kawasaki|kymco|piaggio|motorcycle|motorbike|motor\s+shop|motorshop|auto\s+parts|auto\s+repair|car\s+repair|tire\s+shop|gas\s+station|petrol\s+station|fuel|pharmacy|drugstore|drug\s+store|hospital|clinic|medical\s+center|laboratory|laboratorio|university|college|school|academy|institute|campus|ctu|usc|up\s+(?:cebu|diliman)|bank|atm|lending|pawn|remittance|cooperative|church|parish|cathedral|basilica|chapel|shrine|mosque|temple|terminal|port|station|airport|jetty|wharf|government|municipal\s+hall|city\s+hall|barangay\s+hall|capitol|public\s+market|wet\s+market|grocery|supermarket|sm\s+(?:city|seaside|savemore|hypermart|supermarket)|department\s+store|mall|warehouse|coffee\s+shop\s+only|food\s+court|fast\s+food|restaurant\s+only|cafe\s+only|7-?eleven|alfamart|ministop|family\s+mart|lawson|cebuana|m\s+lhuillier|palawan\s+pawnshop|western\s+union|bdo|bpi|metrobank|landbank|chinabank|unionbank|psbank|maybank|aub|security\s+bank|rcbc|pnb|eastwest|robinsons\s+bank|jollibee|mcdonald'?s|kfc|chowking|mang\s+inasal|pancake\s+house|max'?s|greenwich|burger\s+king|wendy'?s|starbucks|the\s+coffee\s+bean|coffee\s+bean|seattle'?s\s+best|figaro|costa\s+coffee|tim\s+hortons?|gong\s+cha|chatime|cocoa)\b/i;
    const ACCOMMODATION_WHITELIST_RX =
      /\b(?:hotel|hostel|hostal|inn|resort|guesthouse|guest\s+house|pension|pensionne|pensione|lodge|lodging|apartment|apartelle|apart-?hotel|suite|villa|cottage|cabin|bnb|b&b|bed\s+and\s+breakfast|homestay|motel|dormitory|dorm|transient|condo|condotel|residence|residences|residency|resort\s+hotel|beach\s+resort|island\s+resort|tropics|ryokan|minshuku|chalet|bungalow|riad)\b/i;
    // Lodging-only category hints from provider metadata. Used to allow a
    // name that has no lodging keyword but whose provider category clearly
    // says it's a lodging type ("Lodging", "Hotel", "Hostel", etc.).
    const ACCOMMODATION_CATEGORY_RX =
      /\b(?:lodging|hotel|hostel|guest\s*house|guesthouse|inn|resort|villa|apartment|apartelle|motel|bnb|bed\s+and\s+breakfast|homestay|pension|dorm|condotel|chalet|bungalow|ryokan|riad|residency|residences?|accommodation|sleeping_places?|hospedaje)\b/i;
    for (const place of Array.isArray(places) ? places : []) {
      const name = String(place?.name || "").trim();
      const key = normalizeIntakePlace(name);
      if (!name || !key || seen.has(key)) continue;
      // Drop geographic-only names (city/municipality/province/island/barangay).
      if (/\b(?:city|municipality|province|island|barangay)\b/i.test(name) && !/\b(?:hotel|inn|resort|guest|hostel|pension|lodge|apart|suite|room)\b/i.test(name)) continue;
      // Drop names that clearly look like non-accommodation businesses
      // unless they ALSO contain an accommodation keyword (e.g. "Park Inn",
      // "Bank Apartment"). Whitelist wins over blacklist when both match.
      const looksNonAccommodation = ACCOMMODATION_BLACKLIST_RX.test(name);
      const looksAccommodation = ACCOMMODATION_WHITELIST_RX.test(name);
      if (looksNonAccommodation && !looksAccommodation) continue;
      // Worldwide-safe HARD requirement: the name OR the provider category
      // must contain a lodging keyword. Otherwise drop. Catches Siargao-
      // style leaks like "Strum Siargao", "Ink Digger Tattoo Siargao",
      // "Shaka Siargao" — none of which are actual accommodations.
      const categoryText = [
        place?.primaryType,
        place?.category,
        Array.isArray(place?.types) ? place.types.join(" ") : "",
        Array.isArray(place?.categories) ? place.categories.map((c) => c?.name || c).join(" ") : "",
      ].filter(Boolean).join(" ");
      const hasLodgingCategory = categoryText ? ACCOMMODATION_CATEGORY_RX.test(categoryText) : false;
      if (!looksAccommodation && !hasLodgingCategory) {
        console.log(`[Itinerary] accommodation filter dropped non-lodging result: ${name}`);
        continue;
      }
      // Also drop results whose provider category clearly indicates a
      // non-accommodation type. map provider/place search sometimes returns
      // category strings like "Motorcycle Shop", "Pharmacy", "University".
      if (categoryText && ACCOMMODATION_BLACKLIST_RX.test(categoryText) && !ACCOMMODATION_WHITELIST_RX.test(categoryText)) continue;
      seen.add(key);
      unique.push(place);
      if (unique.length >= 5) break;
    }
    if (isBaguioAccommodation && unique.length < 2) {
      return "";
    }
    // Worldwide-safe minimum: if fewer than 3 provider-verified
    // accommodations remain after strict filtering, do NOT show a partial
    // list (which previously surfaced tattoo shops / cafés as fake stays).
    // The caller's downstream prompt path then falls back to base-area
    // guidance via the LLM, which the user actually can act on.
    if (unique.length < 3) return "";

    const headingPrefix = budgetPhrase ? "Budget stays to check" : "Stays to check";
    const headingArea = base || destination;
    // Worldwide-safe continuation question so the user is never stuck after
    // a stay/base recommendation. Tail line offers the practical next step.
    const continuationQuestion = headingArea
      ? `Do you want me to use **${headingArea}** as your base for the itinerary, or pick a different area?`
      : "Do you want me to use that as your base for the itinerary, or pick a different area?";
    return [
      `**${headingPrefix} near ${headingArea}:**`,
      ...unique.map((place) => buildProviderAccommodationBullet(place, headingArea)).filter(Boolean),
      "",
      "I can't verify live rates or availability. Check Agoda, Booking.com, Traveloka, or map search before deciding. TravelMate does not book rooms.",
      "",
      continuationQuestion,
    ].join("\n");
  } catch (error) {
    console.warn("[intake] provider-backed accommodation lookup failed", { err: String(error?.message || error || "") });
    return "";
  }
}

function latestUserDemandsDraftNow(text = "") {
  return /\b(?:just\s+give\s+me|give\s+me\s+(?:a\s+)?real|don'?t\s+ask\s+again|do\s+not\s+ask\s+again|stop\s+asking|plan\s+it\s+now|build\s+it\s+now|real\s+\d+\s*[- ]?\s*day\s+(?:plan|itinerary))\b/i.test(
    String(text || "")
  );
}

function replyIsSetupOnlyQuestion(reply = "") {
  const text = String(reply || "");
  if (!text) return false;
  if (/\bDraft itinerary\b|^Day\s+\d+\b/im.test(text)) return false;
  return /\b(?:I can build|I still need|need a few|need the next|remaining essentials|Date\/month|Travelers|Budget|Origin|Start time|Base stay)\b/i.test(text);
}

function hasUsableIntakeDestination(tripContext = {}) {
  const destination = String(tripContext.subArea || tripContext.destination || "").trim();
  return Boolean(destination && !isWeakContextValue("destination", destination));
}

function intakeDestinationScope(tripContext = {}) {
  const destination = String(tripContext?.destination || "").trim();
  const subArea = String(tripContext?.subArea || "").trim();
  const baseArea = String(tripContext?.baseArea || tripContext?.hotelArea || "").trim();
  const country = String(tripContext?.country || "").trim();
  const label = normalizeIntakePlace([subArea, destination, country].filter(Boolean).join(" "));
  const destinationKey = normalizeIntakePlace(destination);
  const subAreaKey = normalizeIntakePlace(subArea);
  const baseKey = normalizeIntakePlace(baseArea);

  if (subAreaKey || baseKey) return "specific";
  if (!destinationKey && !country) return "unknown";

  // Broad regions/provinces/countries need a sub-area before planning.
  // Specific towns/islands like Moalboal or Santa Fe already provide enough
  // destination signal; asking "where in this area?" restarts intake.
  if (
    /^(?:cebu|northern cebu|north cebu|southern cebu|south cebu|bohol|palawan|manila|metro manila|baguio|philippines|japan|thailand|vietnam|indonesia|malaysia|south korea|korea)$/.test(destinationKey) ||
    /\b(?:province|region|island group|country|mainland|northern|southern|western|eastern|central)\b/.test(destinationKey)
  ) {
    return "broad";
  }

  return destinationKey ? "specific" : "unknown";
}

function lockedDestinationIsBroad(lock = null) {
  const key = normalizeIntakePlace(lock?.label || "");
  return Boolean(
    key &&
    (
      /^(?:cebu|northern cebu|north cebu|southern cebu|south cebu|bohol|palawan|manila|metro manila|baguio|philippines|japan|thailand|vietnam|indonesia|malaysia|south korea|korea)$/.test(key) ||
      /\b(?:province|region|island group|country|mainland|northern|southern|western|eastern|central)\b/.test(key)
    )
  );
}

function latestUserExplicitlyNarrowsDestination(text = "") {
  const raw = String(text || "");
  return /\b(?:make|set|change|switch|update)\s+(?:it|this|the\s+trip|destination|base|area)?\s*(?:to|as|near|in)\s+[\p{L}]/iu.test(raw) ||
    /\b(?:destination|base|base\s+area|hotel\/base)\s+(?:is|=|should\s+be|to|in|near|at)\s+[\p{L}]/iu.test(raw) ||
    /\b(?:trip|travel|go)\s+(?:to|in)\s+[\p{L}]/iu.test(raw) ||
    /\b(?:stay|staying|base)\s+(?:in|near|at)\s+[\p{L}]/iu.test(raw);
}

function latestUserAddsMustVisitWithoutDestinationOverride(text = "") {
  const raw = String(text || "");
  if (!raw.trim() || latestUserExplicitlyNarrowsDestination(raw)) return false;
  return /\b(?:add|include|visit|see|try|must[-\s]?visit|must[-\s]?try|also|i\s+want\s+to\s+visit|we\s+want\s+to\s+visit|i\s+want|we\s+want)\b/i.test(raw);
}

function shouldAskDestinationSubArea(tripContext = {}) {
  return intakeDestinationScope(tripContext) === "broad" &&
    !tripContext?.subArea &&
    !tripContext?.baseArea;
}

// Warm, destination-aware 1-2 sentence acknowledgment shown before the
// missing-fields list. Keeps the bot from sounding like a cold form.
function buildDestinationAcknowledgment(tripContext = {}) {
  const dayCount = Number(tripContext?.days || 0);
  const rawLabel = String(tripContext?.subArea || tripContext?.destination || tripContext?.country || "").trim();
  const key = normalizeIntakePlace(rawLabel);
  const lengthHint = dayCount ? `${dayCount} day${dayCount === 1 ? "" : "s"}` : "a short trip";

  if (!rawLabel) return "";

  if (/\bbohol\b|\bpanglao\b|\btagbilaran\b|\balona\b|\bdauis\b|\bdumaluan\b|\bloboc\b/.test(key)) {
    return `Got it — Bohol is a great ${lengthHint} for beaches, Chocolate Hills, countryside stops, and relaxed island food.`;
  }
  if (/\bcamiguin\b|\bmambajao\b|\byumbing\b|\bmahinog\b|\bcatarman\b|\bsagay\b/.test(key)) {
    return `Got it — Camiguin is a strong ${lengthHint} for White Island, Mantigue Island, hot springs, waterfalls, and the Sunken Cemetery.`;
  }
  if (/\bcebu\b/.test(key)) {
    return `Got it — Cebu fits ${lengthHint} well with heritage stops, food, and easy day trips like Moalboal or Oslob.`;
  }
  if (/\bmanila\b|\bintramuros\b|\bmakati\b|\bbgc\b/.test(key)) {
    return `Got it — Manila is a strong ${lengthHint} for heritage, food, and city neighborhoods.`;
  }
  if (/\bpalawan\b/.test(key)) {
    return `Got it — Palawan suits ${lengthHint} of lagoons, beaches, and island-hopping.`;
  }
  if (/\bsiquijor\b/.test(key)) {
    return `Got it — Siquijor works for ${lengthHint} of quiet beaches, waterfalls, and a slower pace.`;
  }
  if (/\bbaguio\b/.test(key)) {
    return `Got it — Baguio fits ${lengthHint} of cool weather, gardens, markets, and easy walking stops.`;
  }
  if (/\bsiargao\b/.test(key)) {
    return `Got it — Siargao suits ${lengthHint} of surf beaches, island-hopping, and laid-back nightlife.`;
  }
  if (/\bboracay\b/.test(key)) {
    return `Got it — Boracay fits ${lengthHint} of beach time, water activities, and easy sunset stops.`;
  }
  const place = titleCaseIntakeValue(rawLabel.replace(/,.*$/, ""));
  return `Got it — ${place} sounds like a great ${lengthHint}.`;
}

// Return a provider-backed base/sub-area question instead of hardcoded
// destination option lists.
function buildSubAreaQuestionForDestination(tripContext = {}) {
  return buildBaseAreaQuestionForDestination(tripContext);
}

function intakeFieldPriority(field = {}) {
  const order = [
    "destination_sub_area",
    "travel_dates",
    "trip_length",
    "travelers",
    "budget",
    "origin",
    "start_time",
    "transport",
    "base",
  ];
  const index = order.indexOf(String(field.key || ""));
  return index >= 0 ? index : 999;
}

function selectBundledIntakeFields(fields = []) {
  const sorted = [...fields].sort((a, b) => intakeFieldPriority(a) - intakeFieldPriority(b));
  const hasBroadBaseChoice = sorted.some((field) => String(field.key || "") === "destination_sub_area");
  const hasCoreTripBasics =
    sorted.some((field) => String(field.key || "") === "travel_dates") &&
    sorted.some((field) => String(field.key || "") === "travelers") &&
    sorted.some((field) => String(field.key || "") === "budget");
  const maxFields = hasBroadBaseChoice && hasCoreTripBasics ? 4 : 3;
  return sorted.slice(0, sorted.length === 1 ? 1 : maxFields);
}

function formatBundledIntakeQuestion(fields = [], tripContext = {}, ack = "") {
  const visible = selectBundledIntakeFields(fields);
  if (!visible.length) return "";
  const rawDestinationLabel = formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext);
  const destinationLabel = /^the destination$/i.test(String(rawDestinationLabel || "").trim())
    ? ""
    : rawDestinationLabel;
  const single = visible.length === 1;
  const openings = [
    destinationLabel ? `Nice pick — ${destinationLabel} can work well here.` : "Happy to help — where are you headed?",
    destinationLabel ? `Solid choice — ${destinationLabel} gives us a clear starting point.` : "Happy to help — where are you headed?",
    destinationLabel ? `Got it — ${destinationLabel} is the trip focus.` : "Happy to help — where are you headed?",
  ];
  const opening = ack || openings[
    Math.abs(String(destinationLabel || visible.map((f) => f.label).join("|")).length) % openings.length
  ];
  const lead = single
    ? `${opening}\n\nOne detail will finish the trip summary:`
    : `${opening}\n\nA few details will help me build the right route:`;
  return [
    lead,
    "",
    ...visible.map((field) => `- **${field.label}:** ${field.question}`),
  ].join("\n");
}

function pushDateDurationFields(fields = [], tripContext = {}) {
  const hasDays = Number(tripContext.days || 0) > 0;
  const hasDate = Boolean(tripContext.date);
  if (!hasDate && !hasDays) {
    fields.push({
      key: "travel_dates",
      label: "Dates and length",
      question: "When are you going, and for how many days?",
    });
  } else if (!hasDate) {
    fields.push({
      key: "travel_dates",
      label: "Dates",
      question: "What date are you planning to start?",
    });
  } else if (!hasDays) {
    fields.push({
      key: "trip_length",
      label: "Trip length",
      question: "How many days is the trip?",
    });
  }
}

function buildDestinationFirstClarifier(tripContext = {}) {
  const ack = buildDestinationAcknowledgment(tripContext);
  const fields = [];
  if (!tripContext?.subArea && !tripContext?.destination) {
    fields.push({ key: "destination_sub_area", label: "Destination or area", question: "Where are you headed?" });
  } else if (shouldAskDestinationSubArea(tripContext)) {
    fields.push({ key: "destination_sub_area", label: "Base area", question: buildSubAreaQuestionForDestination(tripContext) });
  }
  pushDateDurationFields(fields, tripContext);
  if (!tripContext.travelers) fields.push({ key: "travelers", label: "Travelers", question: "Who are you traveling with — solo, partner, family, or friends?" });
  if (!tripContext.budget) fields.push({ key: "budget", label: "Budget", question: "What budget should I follow — budget, mid-range, or luxury?" });
  if (!tripContext.origin) fields.push({ key: "origin", label: "Origin", question: "Where are you starting from?" });

  return formatBundledIntakeQuestion(fields, tripContext, ack);
}

function buildFollowUpAcknowledgment(tripContext = {}) {
  // 1-2 sentence acknowledgment after the user has already named base, date,
  // travelers, and/or budget. The goal is to confirm what TravelMate
  // understood from the message instead of restarting the form.
  const destinationLabel = formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext);
  const baseLabel = String(tripContext?.baseArea || tripContext?.subArea || "").trim();
  const destinationOnlyLabel = String(tripContext?.destination || "").trim();
  const travelers = String(tripContext?.travelers || "").toLowerCase();
  const budget = String(tripContext?.budget || "").toLowerCase();
  // Always normalize requests before picking a must-visit so the ack never
  // shows raw copied conversation text like "plan me a 3 day bohol trip...".
  const rawRequests = Array.isArray(tripContext?.specialRequests) ? tripContext.specialRequests.filter(Boolean) : [];
  const normalizedRequests = normalizeSpecialRequestList(rawRequests);
  const dayCount = Number(tripContext?.days || 0);
  const dateText = String(tripContext?.date || tripContext?.dates || "").trim();
  const dateRange = formatIntakeDateRange(dateText, dayCount);

  if (!baseLabel && destinationOnlyLabel) {
    const destinationKey = normalizeIntakePlace(destinationLabel || destinationOnlyLabel);
    if (/\bcamiguin\b/.test(destinationKey)) {
      return "Got it — Camiguin is the destination. I’ll keep the base separate, usually Mambajao / Yumbing if you want the most practical first-time visitor area.";
    }
    if (/\bbohol\b/.test(destinationKey)) {
      return "Got it — Bohol is the destination. I’ll keep the hotel/base separate from the province and any must-visit stops.";
    }
  }
  if (!baseLabel) return "";

  const couplelike = /couple|partner|honeymoon|spouse|girlfriend|boyfriend/.test(travelers);
  const familyish = /family|parents|kids|children|seniors?/.test(travelers);
  const friendsish = /friends|barkada/.test(travelers);
  const soloish = /solo|alone|just me/.test(travelers);
  const audienceWord = couplelike
    ? "couple-friendly"
    : familyish
    ? "family-friendly"
    : friendsish
    ? "friends-trip"
    : soloish
    ? "solo-traveler"
    : "";
  const baseClause = audienceWord
    ? `${baseLabel} will be your ${audienceWord} base`
    : `${baseLabel} will be your base`;
  const mustVisit = normalizedRequests.find((r) => {
    if (!r) return false;
    if (/^breakfast/i.test(r)) return false;
    if (/under\s*(?:₱|php|p\s)/i.test(r)) return false;
    if (/recommend\s+stay/i.test(r)) return false;
    if (/^all major/i.test(r)) return false;
    // Skip anything that still looks like a full sentence.
    if (r.split(/\s+/).length > 5) return false;
    return true;
  });
  const mustVisitClause = mustVisit ? `, and ${mustVisit} can be the trip's highlight stop` : "";
  const tripPrefix = couplelike ? "couple " : familyish ? "family " : friendsish ? "friends " : "";
  const budgetClause = budget ? ` I'll shape this as a ${budget} ${tripPrefix}trip` : "";
  const dateClause = dateRange && dayCount
    ? ` for ${dateRange}.`
    : dateRange
    ? ` for ${dateRange}.`
    : dayCount
    ? ` for ${dayCount} days.`
    : ".";
  return `Got it — ${baseClause}${mustVisitClause}.${budgetClause ? `${budgetClause}${dateClause}` : ""}`.trim();
}

function cleanBaseOptionLabel(option = "", destination = "") {
  const raw = cleanTripFactValue(option)
    .replace(/\b(?:philippines|province|country|region)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
  if (!raw) return "";
  const key = normalizeIntakePlace(raw);
  const destinationKey = normalizeIntakePlace(destination);
  if (!key || key === destinationKey || key.length < 3) return "";
  if (/^(?:city|town|municipality|province|island|area|region|philippines)$/.test(key)) return "";
  return titleCaseIntakeValue(raw);
}

async function resolveBaseAreaOptionsForDestination(tripContext = {}) {
  const destination = formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext);
  if (!destination || destination === "the destination") return [];

  const results = [];
  try {
    const geoQueries = [
      destination,
      `areas in ${destination}`,
      `towns in ${destination}`,
      `municipalities in ${destination}`,
    ];
    for (const query of geoQueries) {
      const geo = typeof searchAreaCandidates === "function"
        ? await searchAreaCandidates(query, {
          limit: 10,
          resultTypes: ["city", "town", "village", "municipality", "suburb", "district", "locality", "county"],
          providerTimeoutMs: 8000,
        })
        : null;
      for (const item of geo?.results || []) {
        results.push(item.name || item.city || item.town || item.village || item.suburb || item.district || item.county || "");
      }
      if (results.length >= 5) break;
    }
  } catch (error) {
    console.warn("[intake] free geocoder base-option lookup failed", { err: String(error?.message || error || "") });
  }

  if (results.length < 3) {
    try {
      const placeSearch = typeof searchPlaceCandidates === "function"
        ? await searchPlaceCandidates(`areas in ${destination}`, {
            maxResultCount: 8,
            providerTimeoutMs: 8000,
          })
        : null;
      for (const place of placeSearch?.results || []) {
        results.push(place?.name || place?.city || "");
      }
    } catch (error) {
      console.warn("[intake] place search base-option lookup failed", { err: String(error?.message || error || "") });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const value of results) {
    const label = cleanBaseOptionLabel(value, destination);
    const key = normalizeIntakePlace(label);
    if (!label || seen.has(key)) continue;
    seen.add(key);
    unique.push(label);
    if (unique.length >= 5) break;
  }
  return unique;
}

function buildBaseAreaQuestionForDestination(tripContext = {}) {
  const destination = formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext);
  const options = Array.isArray(tripContext.baseAreaOptions)
    ? tripContext.baseAreaOptions.map((item) => cleanBaseOptionLabel(item, destination)).filter(Boolean)
    : [];
  if (options.length) {
    return `Where do you want to stay in ${destination} — ${options.slice(0, 5).join(", ")}, or somewhere else?`;
  }
  return `Which area of ${destination} do you want to stay in?`;
}

function buildTransportQuestionForDestination(tripContext = {}) {
  const destination = formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext);
  const origin = String(tripContext?.origin || "").trim();
  const route = origin && destination && destination !== "the destination"
    ? ` from ${origin} to ${destination}`
    : "";
  return `What transport mode do you want to use${route} — public transport, private car, flight/ferry, or another route?`;
}

async function prepareTripContextForEssentials(tripContext = {}, appContext = {}) {
  if (!tripContext || typeof tripContext !== "object") return tripContext;
  await maybeInferTransportModeFromRoute(tripContext);
  tripContext.essentialsComplete = recomputeTripEssentialsComplete(tripContext);
  const localTrip = isLocalIntakeTrip(tripContext);
  if (!tripContext.essentialsComplete && !localTrip && !tripContext.baseArea && tripContext.noHotelYet !== true) {
    tripContext.baseAreaOptions = await resolveBaseAreaOptionsForDestination(tripContext, appContext);
  }
  return tripContext;
}

async function buildGroupedMissingFieldsQuestionWithProviders(tripContext = {}, appContext = {}) {
  await prepareTripContextForEssentials(tripContext, appContext);
  return buildGroupedMissingFieldsQuestion(tripContext);
}

async function buildBlueprintOrMissingDecision(normalized = {}, recent = [], appContext = {}, options = {}) {
  const tripContext = normalized.tripContext || {};
  await prepareTripContextForEssentials(tripContext, appContext);
  const pendingEdits = Array.isArray(options.pendingEdits)
    ? options.pendingEdits
    : Array.isArray(normalized.pendingEdits)
    ? normalized.pendingEdits
    : [];
  if (tripContext.essentialsComplete) {
    return {
      ...normalized,
      tripContext,
      intent: "show_blueprint",
      shouldGenerate: false,
      pendingEdits,
      replyText: buildCanonicalIntakeBlueprintReply({ ...normalized, tripContext, pendingEdits }, recent),
    };
  }
  return {
    ...normalized,
    tripContext,
    intent: "update_context",
    shouldGenerate: false,
    pendingEdits,
    replyText: buildGroupedMissingFieldsQuestion(tripContext),
  };
}

function buildGroupedMissingFieldsQuestion(tripContext = {}) {
  if (!hasUsableIntakeDestination(tripContext)) return buildDestinationFirstClarifier(tripContext);

  const localTrip = isLocalIntakeTrip(tripContext);
  const fields = [];
  if (shouldAskDestinationSubArea(tripContext)) {
    fields.push({ key: "destination_sub_area", label: "Base area", question: buildSubAreaQuestionForDestination(tripContext) });
  }
  pushDateDurationFields(fields, tripContext);
  if (!tripContext.travelers) fields.push({ key: "travelers", label: "Travelers", question: "Who are you traveling with — solo, partner, family, or friends?" });
  if (!tripContext.budget) fields.push({ key: "budget", label: "Budget", question: "What budget should I follow — budget, mid-range, or luxury?" });
  if (!tripContext.origin) fields.push({ key: "origin", label: "Origin", question: "Where are you starting from?" });
  if (!tripContext.startTime) fields.push({ key: "start_time", label: "Start time", question: "What time do you want to leave or arrive — morning, afternoon, or evening?" });
  if (!localTrip && !tripContext.transportMode) {
    fields.push({ key: "transport", label: "Transport", question: buildTransportQuestionForDestination(tripContext) });
  }
  if (!localTrip && !tripContext.baseArea && tripContext.noHotelYet !== true) {
    fields.push({ key: "base", label: "Base area", question: buildBaseAreaQuestionForDestination(tripContext) });
  }

  const ack = buildFollowUpAcknowledgment(tripContext);
  return formatBundledIntakeQuestion(fields, tripContext, ack);
}

function needsDestinationFirstClarifier(parsed = {}, reply = "") {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.shouldGenerate || parsed.intent === "show_blueprint" || parsed.intent === "confirm_generate") return false;
  if (hasUsableIntakeDestination(parsed.tripContext || {})) return false;
  const text = String(reply || parsed.replyText || "");
  return replyIsSetupOnlyQuestion(text) && !/-\s+\*\*Destination(?:\s+or\s+area)?:\*\*/i.test(text);
}

function getHighlightItemsForDraft(tripContext = {}) {
  const label = String(tripContext?.subArea || tripContext?.destination || "").trim();
  const key = normalizeIntakePlace(label);
  if (/\bel nido\b/.test(key)) {
    return [
      ["Big Lagoon", "anchor the island-hopping day around the classic turquoise-lagoon stop."],
      ["Small Lagoon", "add a calmer paddle-and-swim lagoon stop if tour routing allows."],
      ["Nacpan Beach", "keep one slower beach block for a less rushed afternoon."],
      ["Las Cabanas Beach", "use this as the easiest sunset stop near the main base."],
      ["El Nido Town Proper", "keep meals and tour logistics close to the port area."],
    ];
  }
  const known = findKnownDestinationHighlights(key);
  return known ? known.items : [];
}

function nextMissingFinalQuestion(tripContext = {}) {
  const localTrip = isLocalIntakeTrip(tripContext);
  if (!tripContext.date) return ["Date", "What date are you planning to travel?"];
  if (!tripContext.travelers) return ["Travelers", "Solo, partner, family, friends, parents, or group?"];
  if (!tripContext.budget) return ["Budget", "Budget, mid-range, or luxury?"];
  if (!tripContext.origin) return ["Origin", "Where are you starting from?"];
  if (!tripContext.startTime) return ["Start time", "What time do you want to leave or arrive?"];
  if (!localTrip && !tripContext.transportMode) return ["Transport", buildTransportQuestionForDestination(tripContext)];
  if (!localTrip && !tripContext.baseArea && tripContext.noHotelYet !== true) {
    return ["Base area", buildBaseAreaQuestionForDestination(tripContext)];
  }
  return null;
}

function adjustDraftHighlightNote(name = "", note = "", latestUser = "") {
  if (/\btaal\b/i.test(name) && /\bhalf\s+(?:a\s+)?day\b/i.test(String(latestUser || ""))) {
    return "keep this as the half-day volcano-view anchor, then leave the rest of the day for gentler Tagaytay stops.";
  }
  return note;
}

function buildDraftItineraryReply(tripContext = {}, latestUser = "") {
  const destination = formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext);
  const days = Math.max(1, Math.min(Number(tripContext.days || 0) || 1, 5));
  const items = getHighlightItemsForDraft(tripContext);
  if (!destination || !items.length) return "";

  const effectiveDays = Math.min(days, items.length);
  const dayBuckets = Array.from({ length: effectiveDays }, () => []);
  items.forEach((item, index) => {
    dayBuckets[index % effectiveDays].push(item);
  });

  const lines = [
    `**Draft itinerary for ${destination}**`,
    "",
    "This is a working version using the trip details already in the chat. I can turn it into the final saveable itinerary after one last detail.",
  ];

  dayBuckets.forEach((bucket, index) => {
    lines.push("", `**Day ${index + 1}:**`);
    for (const [name, note] of bucket) {
      lines.push(`- **${name}:** ${adjustDraftHighlightNote(name, note, latestUser)}`);
    }
  });

  const nextQuestion = nextMissingFinalQuestion(tripContext);
  if (nextQuestion) {
    lines.push(
      "",
      "To finalize this into the timed itinerary:",
      `- **${nextQuestion[0]}:** ${nextQuestion[1]}`
    );
  }

  return lines.join("\n");
}

function titleCaseIntakeValue(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b([a-z])/gi, (char) => char.toUpperCase())
    .replace(/\bAnd\b/g, "and")
    .replace(/\bOf\b/g, "of")
    .replace(/\bThe\b/g, "the");
}

function extractSpecificDestinationFromLatestUser(latestUser = "") {
  const text = String(latestUser || "");
  const match = text.match(/\b(?:want\s+to\s+go\s+to|go\s+to|travel\s+to|trip\s+to|stay\s+in|base\s+in)\s+([a-z][a-z\s.'-]{1,50}?)(?:\s*(?:,|\.|!|\?|$)|\s+(?:our|we|with|and|from|flight|budget|hotel|hostel|place|can|recommend|though)\b)/i);
  if (!match) return "";
  const candidate = titleCaseIntakeValue(match[1]);
  if (/^(A|An|The|There|This|That|It|We|Us|Me|My|Our)$/i.test(candidate)) return "";
  return candidate;
}

function extractOriginFromLatestUser(latestUser = "") {
  const text = normalizeIntakeDestinationTypos(latestUser);
  const explicit = text.match(/\b(?:we\s+are|we're|i\s+am|i'm)?\s*from\s+([a-z][a-z\s.'-]{1,40}?)(?:\s*(?:,|\.|!|\?|$)|\s+(?:our|we|with|and|flight|departure|budget|traveling|travelling|going|go|to|but|though|can)\b)/i);
  if (!explicit) return "";
  const candidate = titleCaseIntakeValue(explicit[1]);
  if (/^(A|An|The|There|This|That|It|We|Want|Go)$/i.test(candidate)) return "";
  return candidate;
}

function extractBareOriginFromLatestUser(latestUser = "", tripContext = {}) {
  const text = String(latestUser || "");
  const destinationKey = normalizeIntakePlace(formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext));
  if (/\bcebu\b/i.test(text) && !/\bcebu\b/.test(destinationKey)) return "Cebu";
  return "";
}

function extractStartTimeFromLatestUser(latestUser = "") {
  const match = String(latestUser || "").match(/\b(?:flight|departure|depart|leave|leaving|start(?:ing)?)\s*(?:is|at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = match[2] || "00";
  const suffix = match[3].toUpperCase();
  if (!hour || hour > 12) return "";
  return `${hour}:${minute} ${suffix}`;
}

function classifyTripBudgetTierFromAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 10000) return "Budget";
  if (value < 25000) return "Mid-range";
  return "Luxury";
}

function extractRecentTripBudgetTier(recent = []) {
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    if (!turn || turn.role !== "user") continue;
    const text = String(turn.content || "");
    const delimitedTier = extractDelimitedTripBudgetTier(text);
    if (delimitedTier) return delimitedTier;
    if (textHasAccommodationBudgetContext(text) && !/\b(?:trip|travel|itinerary|overall|total|all[-\s]?in|per\s+(?:person|pax|head)|each|pp)\b/i.test(text)) continue;
    if (/\bmid\s*-?\s*rang(?:e|ed)?\b|\bmidrang(?:e|ed)?\b/i.test(text)) return "Mid-range";
    if (/\bluxury\b/i.test(text)) return "Luxury";
    if (/\b(?:budget[-\s]?friendly|budget\s+(?:trip|travel|option|plan)|on\s+(?:a\s+)?budget|tight\s+budget|cheap|affordable|tipid)\b/i.test(text) || /^\s*budget\s*$/i.test(text)) {
      return "Budget";
    }
    const amountBeforeBudget =
      text.match(/(?:₱|php|p)?\s*(\d{1,3}(?:[,.]?\d{3})*|\d+)\s*(k|thousand)?\s*(?:budget|allowance|spending|all[-\s]?in)\s*(?:each|per\s+(?:person|pax|head)|\/person|pp)?/i);
    const amountAfterBudget =
      text.match(/\b(?:budget|spend|spending|allowance|all[-\s]?in)\b[^\n.?!]{0,80}?(?:₱|php|p)?\s*(\d{1,3}(?:[,.]?\d{3})*|\d+)\s*(k|thousand)?\b/i);
    const match = amountBeforeBudget || amountAfterBudget;
    if (!match) continue;
    const base = Number(String(match[1]).replace(/[,.]/g, ""));
    const multiplier = /\b(?:k|thousand)\b/i.test(match[2] || "") ? 1000 : 1;
    const tier = classifyTripBudgetTierFromAmount(base * multiplier);
    if (tier) return tier;
  }
  return "";
}

function formatIntakeBudgetLabel(value = "") {
  const label = String(value || "").trim();
  if (!label) return "";
  if (/mid/i.test(label)) return "Mid-range";
  if (/lux/i.test(label)) return "Luxury";
  if (/budget/i.test(label)) return "Budget";
  return label;
}

function cleanIntakeFieldValue(value = "") {
  return String(value || "")
    .replace(/^\s*(?:[-*•]\s*)?/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isWeakContextValue(field = "", value = "") {
  const raw = String(value || "").trim();
  const key = normalizeIntakePlace(raw);
  if (!key) return true;
  if (/^(?:me|us|we|you|i|my|our|it|this|that|there|here|to confirm|pending|unknown|none|n\/a)$/i.test(raw)) {
    return true;
  }
  if (field === "destination" && /^(?:me a|stay|stays|hotel|hotels|place|places|where to stay|recommendation|base)$/i.test(raw)) {
    return true;
  }
  if (/^(?:flexible date|general traveler|assumption accepted)$/i.test(raw)) return true;
  if (/\bWe Want\b/i.test(raw)) return true;
  if (field === "origin" && /\b(?:budget|coming from|leave|leaving|private car|mid-range|next week)\b/i.test(raw)) {
    return true;
  }
  if (field === "destination" && /\b(?:coming from|leave|leaving|private car|budget)\b/i.test(raw)) {
    return true;
  }
  return false;
}

function splitBlueprintDestination(value = "") {
  const parts = cleanIntakeFieldValue(normalizeIntakeDestinationTypos(value))
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length || isWeakContextValue("destination", parts[0])) return {};

  const country = parts.length > 1 && /philippines|japan|thailand|vietnam|korea|malaysia|indonesia|singapore/i.test(parts[parts.length - 1])
    ? parts[parts.length - 1]
    : "";
  const withoutCountry = country ? parts.slice(0, -1) : parts;

  if (withoutCountry.length >= 2) {
    if (/\bcamiguin\b/i.test(withoutCountry.join(" "))) {
      return { destination: "Camiguin", country: country || "Philippines" };
    }
    return {
      subArea: withoutCountry[0],
      destination: withoutCountry.slice(1).join(", "),
      country,
    };
  }

  const destination = canonicalIntakeDestinationName(withoutCountry[0]) || withoutCountry[0];
  return {
    destination,
    country: country || (/\bcamiguin\b|\bbohol\b/i.test(destination) ? "Philippines" : ""),
  };
}

function parseBlueprintDurationDays(value = "") {
  const match = String(value || "").match(/\b(\d{1,2})\s*(?:day|days|d)\b/i);
  if (!match) return null;
  const days = Number(match[1]);
  return Number.isFinite(days) && days > 0 ? days : null;
}

function extractLatestBlueprintContext(recent = []) {
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    if (!turn || turn.role !== "assistant") continue;
    const text = String(turn.content || "");
    if (!looksLikeBlueprintReply(text)) continue;

    const context = {};
    const lines = text.split("\n").map(cleanIntakeFieldValue).filter(Boolean);

    for (const line of lines) {
      const match = line.match(/^([A-Za-z/ ]{3,24}):\s*(.+)$/);
      if (!match) continue;
      const label = String(match[1] || "").trim().toLowerCase();
      const value = cleanIntakeFieldValue(match[2]);
      if (!value) continue;

      if (label === "destination") Object.assign(context, splitBlueprintDestination(value));
      else if (label === "origin" && !isWeakContextValue("origin", value)) context.origin = value;
      else if (label === "dates" || label === "date") context.date = value;
      else if (label === "duration") {
        const days = parseBlueprintDurationDays(value);
        if (days) context.days = days;
      } else if (label === "travelers") context.travelers = value;
      else if (label === "style") context.theme = value;
      else if (label === "start" || label === "start time" || label === "departure") context.startTime = value;
      else if (label === "budget") context.budget = String(value).toLowerCase();
      else if (label === "hotel/base" || label === "base") context.baseArea = value;
      else if (label === "transport") context.transportMode = value;
      else if (label === "breakfast") {
        context.breakfastIncluded = /\bincluded\b|\bbreakfast\b|\bbrunch\b/i.test(value) &&
          !/\bnot\s+included\s+unless\s+requested\b|\bnot\s+included\b/i.test(value);
        context.breakfastNote = context.breakfastIncluded ? value : "";
      } else if (label === "special requests" || label === "special request") {
        context.specialRequests = uniqueIntakeLabels(value.split(/,\s+(?!\d{3}\b)/));
      }
    }

    if (!context.startTime) {
      const startMatch = text.match(/^\s*(?:[-*]\s*)?(?:\*\*)?Start(?:\s*time)?(?:\*\*)?:\s*([^\n]+)/im);
      const startValue = cleanIntakeFieldValue(startMatch?.[1] || "");
      if (startValue) context.startTime = startValue;
    }

    return Object.keys(context).length ? context : null;
  }

  return null;
}

function latestUserLooksLikePendingBlueprintRevision(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (latestUserBypassesPendingBlueprintRevision(t)) return false;
  if (/\b(?:plan|give|make|create|build)\s+(?:me\s+)?(?:a\s+)?\d+\s*[- ]?\s*day\s+(?:trip|itinerary)\s+(?:to|in|for)\b/i.test(t)) {
    return false;
  }
  return /\b(?:before\s+you\s+generate|before\s+generating|make\s+sure|include|add|avoid|not\s+too\s+many|remove|keep|don'?t\s+include|do\s+not\s+include)\b/i.test(t);
}

async function normalizePendingBlueprintEdit(text = "", options = {}) {
  if (parseSpecialRequestCorrection(text)) return "";
  const breakfast = extractBreakfastPreferenceFromText(text);
  if (breakfast?.breakfastIncluded) return "";
  const normalized = normalizeSpecialRequestText(text);
  if (normalized && /\bfamous local food\b|\blight nightlife\b|\bchurches\b/i.test(normalized)) {
    return normalized;
  }
  // If the text contains named must-visits we already extract elsewhere
  // (White Island / Katibawasan Falls / etc.), prefer the canonical
  // labels — never produce a truncated raw paragraph that drops the last
  // word ("...Katibawasan Falls" losing "Falls").
  const namedMustVisits = await extractKnownMustVisitsFromText(text, {
    tripContext: options.tripContext || {},
  });
  if (namedMustVisits.length) {
    return namedMustVisits.join(", ");
  }
  if (normalized) return normalized;
  const cleaned = String(text || "")
    .replace(/^\s*before\s+you\s+generate,?\s*/i, "")
    .replace(/^\s*before\s+generating,?\s*/i, "")
    .replace(/^\s*can\s+you\s+/i, "")
    .replace(/^\s*please\s+/i, "")
    .replace(/^\s*(?:include|add)\s+/i, "")
    .replace(/^\s*(?:i\s+want\s+to\s+visit|i\s+want|we\s+like|we\s+want|i\s+like)\s+/i, "")
    .replace(/\bcan\s+you\s+add\s+that\b/ig, "")
    .replace(/\s+/g, " ")
    .replace(/[?!.]+$/g, "")
    .trim();
  if (!cleaned) return "";
  // Word-boundary truncation so a trailing place-name suffix like "Falls"
  // is never sliced mid-character at 177.
  if (cleaned.length > 200) {
    const window = cleaned.slice(0, 200);
    const lastBreak = Math.max(
      window.lastIndexOf(", "),
      window.lastIndexOf("; "),
      window.lastIndexOf(" and "),
      window.lastIndexOf(" ")
    );
    return `${(lastBreak > 80 ? window.slice(0, lastBreak) : window).trim()}…`;
  }
  return cleaned;
}

function looksLikeFinalItineraryText(text = "") {
  const t = String(text || "");
  return /^Day\s+\d+\s+—/im.test(t) &&
    /\bTrip dates:\s*\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}\b/i.test(t);
}

function extractLatestTripContextForInheritance(recent = []) {
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    if (!turn || turn.role !== "assistant") continue;
    const text = String(turn.content || "");

    const blueprint = extractLatestBlueprintContext([turn]);
    if (blueprint) return { type: "blueprint", context: blueprint, text };

    if (!looksLikeFinalItineraryText(text)) continue;
    const context = {};
    const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) || "";
    const firstParts = firstLine.split("•").map((part) => part.trim()).filter(Boolean);
    if (firstParts[0]) Object.assign(context, splitBlueprintDestination(firstParts[0]));
    const tripDates = text.match(/^Trip dates:\s*(.+)$/im);
    if (tripDates?.[1]) context.date = tripDates[1].trim();
    const baseLine = text.match(/^Base:\s*(.+)$/im);
    if (baseLine?.[1]) {
      const baseParts = baseLine[1].split("•").map((part) => part.trim()).filter(Boolean);
      if (baseParts[0]) context.baseArea = baseParts[0];
      const budgetPart = baseParts.find((part) => /^Budget:/i.test(part));
      if (budgetPart) context.budget = budgetPart.replace(/^Budget:\s*/i, "").trim().toLowerCase();
    }
    const dayCount = (text.match(/^Day\s+\d+\s+—/gim) || []).length;
    if (dayCount) context.days = dayCount;
    const priorBlueprint = extractLatestBlueprintContext(recent.slice(0, i));
    const mergedContext = priorBlueprint
      ? mergePriorBlueprintContext(context, priorBlueprint, { force: false })
      : context;
    if (Object.keys(mergedContext).length) return { type: "itinerary", context: mergedContext, text };
  }
  return null;
}

function latestUserStartsNewTripRequest(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/\b(?:same settings|same details|same as|use the same|reuse)\b/i.test(t)) return false;
  return /\b(?:now\s+)?(?:plan|make|create|build|give me)\s+(?:me\s+)?(?:a\s+)?\d+\s*[- ]?\s*day\s+(?:trip|itinerary)\s+(?:to|in|for)\b/i.test(t) ||
    /\b(?:switch(?:ing)?\s+to|new\s+(?:trip|itinerary)\s+(?:to|in|for))\b/i.test(t);
}

function latestUserProvidesFullNewTripSettings(text = "") {
  const t = String(text || "");
  if (!t.trim()) return false;
  return /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}|\b\d{4}-\d{2}-\d{2}\b/i.test(t) &&
    /\b(?:solo|parents?|family|friends?|partner|couple|kids?|group)\b/i.test(t) &&
    /\b(?:budget|mid\s*-?\s*range|midrange|luxury|₱|php|p\s*\d)/i.test(t) &&
    /\bfrom\s+[a-z]/i.test(t) &&
    /\b(?:morning|afternoon|evening|night|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.test(t) &&
    /\b(?:car|private car|bus|van|flight|ferry|train|public transport|grab|taxi)\b/i.test(t);
}

function previousAssistantAskedInheritanceConfirmation(recent = []) {
  const latestUserIndex = (() => {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (recent[i]?.role === "user") return i;
    }
    return -1;
  })();
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (recent[i]?.role !== "assistant") continue;
    return /Should I use the same trip settings as your previous/i.test(String(recent[i].content || ""));
  }
  return false;
}

function latestUserExplicitlyRejectsInheritance(text = "") {
  return /^\s*(?:no|nope|nah|different|new details|change|let me enter|fresh)\b/i.test(String(text || ""));
}

function latestUserExplicitlyAcceptsInheritance(text = "") {
  return /^\s*(?:yes|yep|yeah|sure|ok|okay|use same|same|same settings|go ahead)\b/i.test(String(text || ""));
}

function latestUserProvidesBaseSetting(text = "") {
  return /\b(?:base|stay|hotel|sleep|book(?:ing)?|near|around|intramuros|quiapo|ermita|makati|bgc|session road|burnham|town proper|city center|city centre)\b/i.test(String(text || ""));
}

function extractNewTripDestinationLabel(tripContext = {}, latestUser = "") {
  const fromContext = formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext);
  if (fromContext && fromContext !== "the destination") return fromContext;
  const m = String(latestUser || "").match(/\b(?:trip|itinerary)\s+(?:to|in|for)\s+([\p{L}\p{M}'.\- ]{2,80}?)(?=\s+(?:for|with|from|on|in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))|[.?!,]|$)/iu);
  return titleCaseIntakeValue(m?.[1] || "the new destination");
}

function formatInheritedTripDate(value = "") {
  const raw = String(value || "").trim();
  const isoStart = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+to\s+\d{4}-\d{2}-\d{2})?$/i);
  if (isoStart) {
    const date = new Date(Date.UTC(Number(isoStart[1]), Number(isoStart[2]) - 1, Number(isoStart[3]), 12, 0, 0));
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
    }
  }
  return raw;
}

function buildTripSwitchInheritanceConfirmation({ latestUser = "", tripContext = {}, previous = null } = {}) {
  const prev = previous?.context || {};
  const previousDestination = formatIntakeDestination(prev) || getIntakeDestinationLabel(prev);
  const nextDestination = extractNewTripDestinationLabel(tripContext, latestUser);
  const inherited = [];
  if (prev.travelers) inherited.push(["Travelers", prev.travelers]);
  if (prev.date) inherited.push(["Date", formatInheritedTripDate(prev.date)]);
  if (prev.budget) inherited.push(["Budget", formatIntakeBudgetLabel(prev.budget) || prev.budget]);
  if (prev.origin) inherited.push(["Origin", prev.origin]);
  if (prev.startTime) inherited.push(["Start time", prev.startTime]);
  if (prev.transportMode) inherited.push(["Transport", prev.transportMode]);

  return [
    `Switching to **${nextDestination}**.`,
    "",
    `Should I use the same trip settings as your previous ${previousDestination || "trip"} plan?`,
    ...inherited.map(([label, value]) => `- **${label}:** ${value}`),
    "",
    "Reply **yes** to keep these, or **no** to enter new details.",
  ].join("\n");
}

// Inheritance disabled: every destination switch now starts fresh.
// Previously this list controlled which fields carried over from the
// prior trip when the user said "yes use that". That mechanism leaked
// destination-mismatched dates, travelers, style, transport, and
// special_requests (Kawasan Falls into Tokyo, etc.) into new trips.
// The list is kept empty to short-circuit the inheritance loop while
// preserving any callers that read the constant.
const DESTINATION_SWITCH_INHERIT_FIELDS = [];

const DESTINATION_SWITCH_VIBE_BY_KEY = {
  baguio: "mountains",
  sagada: "mountains",
  banaue: "mountains",
  bantayan: "beaches",
  siargao: "beaches",
  boracay: "beaches",
  "el nido": "beaches",
  elnido: "beaches",
  coron: "beaches",
  camiguin: "beaches",
  siquijor: "beaches",
  panglao: "beaches",
  "santa fe": "beaches",
  "sta fe": "beaches",
  manila: "city",
  cebu: "city",
  "cebu city": "city",
  makati: "city",
  bgc: "city",
  bohol: "countryside",
  loboc: "countryside",
  anda: "countryside",
};

function destinationSwitchKey(value = "") {
  const key = normalizeIntakePlace(value)
    .replace(/\b(?:island|city|province|philippines)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!key) return "";
  if (/\bbantayan\b|\bsanta fe\b|\bsta fe\b/.test(key)) return "bantayan";
  if (/\bbaguio\b/.test(key)) return "baguio";
  if (/\bel\s*nido\b|\belnido\b/.test(key)) return "el nido";
  if (/\bcebu\b/.test(key) && !/\bbantayan\b/.test(key)) return "cebu";
  return key;
}

function destinationSwitchDisplayName(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const key = destinationSwitchKey(raw);
  if (key === "bantayan") return "Bantayan";
  if (key === "cebu") return /\bcebu\s+city\b/i.test(raw) ? "Cebu City" : "Cebu";
  const cleaned = raw
    .replace(/\s*,\s*Philippines\b/i, "")
    .replace(/\s+Island\b/i, "")
    .replace(/\s+City\b/i, (match) => match)
    .trim();
  return titleCaseIntakeValue(cleaned || raw);
}

async function destinationSwitchCountry(value = "") {
  const resolved = await resolveIntakeDestinationCandidate(value);
  return resolved?.country || "";
}

function destinationSwitchVibeOf(value = "") {
  const key = destinationSwitchKey(value);
  if (!key) return "";
  if (DESTINATION_SWITCH_VIBE_BY_KEY[key]) return DESTINATION_SWITCH_VIBE_BY_KEY[key];
  const compact = key.replace(/\s+/g, "");
  return DESTINATION_SWITCH_VIBE_BY_KEY[compact] || "";
}

function destinationSwitchesLikelySame(a = "", b = "") {
  const ak = destinationSwitchKey(a);
  const bk = destinationSwitchKey(b);
  if (!ak || !bk) return false;
  if (ak === bk) return true;
  return (ak.length >= 4 && bk.includes(ak)) || (bk.length >= 4 && ak.includes(bk));
}

function destinationSwitchOldDestinationFromContext(continuity = {}) {
  const ctx = continuity?.itineraryContext || continuity || {};
  const direct = String(ctx.destination || ctx.destinationName || "").trim();
  if (direct) return destinationSwitchDisplayName(direct);
  const activeText = String(ctx.activeItineraryText || ctx.latestItinerary || ctx.latestVisibleItinerary || "").trim();
  if (!activeText) return "";
  const destinationLine = activeText.match(/^Destination:\s*(.+)$/im);
  if (destinationLine?.[1]) return destinationSwitchDisplayName(destinationLine[1]);
  const firstLine = activeText
    .split("\n")
    .map((line) => String(line || "").trim())
    .find((line) => line && !/^Trip dates:/i.test(line) && !/^Base:/i.test(line) && !/^Day\s+\d+/i.test(line));
  const candidate = String(firstLine || "").split("•")[0].trim();
  return candidate ? destinationSwitchDisplayName(candidate) : "";
}

function cleanDestinationSwitchCandidate(value = "") {
  return cleanTripFactValue(
    String(value || "")
      .replace(/\bfor\s+\d+\s*[- ]?\s*days?\b[\s\S]*$/i, "")
      .replace(/\b(?:with|from|on|starting|start(?:ing)?|leave|leaving|depart|budget|mid\s*-?\s*range|luxury|friends?|family|solo)\b[\s\S]*$/i, "")
      .replace(/[?.!,;:]+$/g, "")
      .trim()
  );
}

async function extractDestinationSwitchCandidate(latestUser = "") {
  const text = normalizeIntakeDestinationTypos(String(latestUser || "").trim());
  if (!text) return "";
  const destinationChunk = "([\\p{L}\\p{M}'.\\- ]{2,90})";
  const patterns = [
    new RegExp(`\\b(?:i|we)\\s+(?:want|wanna|would\\s+like|like)\\s+to\\s+(?:go|visit|travel|head)\\s+to\\s+${destinationChunk}`, "iu"),
    new RegExp(`\\b(?:go|visit|travel|head)\\s+to\\s+${destinationChunk}`, "iu"),
    new RegExp(`\\b(?:plan|make|create|build|draft|generate)\\s+(?:me\\s+)?(?:a\\s+)?(?:\\d+\\s*[- ]?\\s*day\\s+)?(?:trip|itinerary|plan)\\s+(?:to|in|for)\\s+${destinationChunk}`, "iu"),
    new RegExp(`\\b(?:trip|itinerary|plan)\\s+(?:to|in|for)\\s+${destinationChunk}`, "iu"),
    new RegExp(`\\b(?:switch(?:ing)?|change(?:ing)?|move|moving)\\s+(?:over\\s+)?to\\s+${destinationChunk}`, "iu"),
    new RegExp(`\\blet'?s\\s+(?:do|try|visit)\\s+${destinationChunk}`, "iu"),
  ];

  for (const rx of patterns) {
    const match = text.match(rx);
    const cleaned = cleanDestinationSwitchCandidate(match?.[1] || "");
    if (!cleaned) continue;
    const known = (await knownIntakeDestinationFromText(cleaned)) || canonicalIntakeDestinationName(cleaned);
    if (known) return destinationSwitchDisplayName(known);
  }

  return "";
}

function destinationSwitchSkipPattern(latestUser = "") {
  const text = String(latestUser || "").trim();
  if (!text) return true;
  if (/\b(?:near|nearby|around|close to)\s+[\p{L}]/iu.test(text)) return true;
  if (/\b(?:how much|cost|costs|price|prices|fare|fares|expense|expenses|food cost|food budget)\b/i.test(text)) return true;
  if (/\b(?:from|coming from|origin|starting from)\s+[\p{L}]/iu.test(text) && !/\b(?:go|visit|travel|trip|itinerary|plan|switch|move)\s+(?:to|in|for|over)\b/i.test(text)) {
    return true;
  }
  if (
    /\b(?:add|include|insert|put|remove|replace|move|shift|reorder|delete|drop|skip|avoid|edit|update)\b/i.test(text) &&
    !/\b(?:destination|switch|new\s+(?:trip|itinerary|plan)|go\s+to|travel\s+to|trip\s+(?:to|in|for)|itinerary\s+(?:to|in|for))\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

async function detectDestinationSwitch(latestUser = "", continuity = {}) {
  if (!continuity?.itineraryContext?.hasActiveItinerary) {
    return { switching: false, newDestination: "", oldDestination: "" };
  }
  if (destinationSwitchSkipPattern(latestUser)) {
    return { switching: false, newDestination: "", oldDestination: "" };
  }
  const newDestination = await extractDestinationSwitchCandidate(latestUser);
  const oldDestination = destinationSwitchOldDestinationFromContext(continuity);
  if (!newDestination || !oldDestination || destinationSwitchesLikelySame(newDestination, oldDestination)) {
    return { switching: false, newDestination: "", oldDestination: oldDestination || "" };
  }
  return {
    switching: true,
    newDestination: destinationSwitchDisplayName(newDestination),
    oldDestination: destinationSwitchDisplayName(oldDestination),
  };
}

function formatDestinationSwitchDuration(days = "") {
  const count = Number(days || 0);
  if (Number.isFinite(count) && count > 0) return `${count} day${count === 1 ? "" : "s"}`;
  const raw = String(days || "").trim();
  return raw || "to confirm";
}

function formatDestinationSwitchDate(value = "", days = 0) {
  const raw = String(value || "").trim();
  if (!raw) return "to confirm";
  return formatIntakeDateRange(raw, Number(days || 0)) || raw;
}

function buildDestinationSwitchOpener(oldDestination = "", newDestination = "") {
  const oldName = destinationSwitchDisplayName(oldDestination);
  const newName = destinationSwitchDisplayName(newDestination);
  const oldVibe = destinationSwitchVibeOf(oldName);
  const newVibe = destinationSwitchVibeOf(newName);
  if (oldVibe && newVibe && oldVibe !== newVibe) {
    if (oldVibe === "mountains" && newVibe === "beaches") {
      return `Got it — switching from mountains to beaches. ${newName} is a different pace from ${oldName}.`;
    }
    if (oldVibe === "beaches" && newVibe === "city") {
      return `Got it — switching from beaches to city. ${newName} has a very different rhythm.`;
    }
    if (newVibe === "countryside") {
      return `Got it — moving over to ${newName}. Different island, slower beach-and-countryside pace.`;
    }
    return `Got it — switching from ${oldVibe} to ${newVibe}. ${newName} is a different pace from ${oldName}.`;
  }
  if (oldName && newName) return `Got it — switching from ${oldName} to ${newName}.`;
  return `Got it — switching to ${newName || "the new destination"}.`;
}

function buildDestinationSwitchPrompt(oldContext = {}, newDestination = "") {
  const oldDestination = destinationSwitchDisplayName(oldContext.destination || oldContext.destinationName || "your previous trip");
  const newName = destinationSwitchDisplayName(newDestination) || "this new trip";

  // No more inheritance prompt. Every destination change is treated as a
  // clean slate. The previous "Reusable from your X plan: ..." flow
  // leaked dates, travelers, style, transport, and special_requests
  // (Kawasan Falls, Camp Sawi, etc.) from the prior trip into the new
  // one. Acknowledge the switch and ask for fresh details so the user
  // re-states what's relevant to the new destination.
  return [
    `Got it — switching to **${newName}**.`,
    "",
    "Let me get fresh details so I don't carry over anything that doesn't fit this new destination:",
    "",
    `- **Travel dates:** When are you going?`,
    `- **Travelers:** Who's going on this trip — solo, couple, friends, or family?`,
    `- **Budget:** What budget should I follow — budget, mid-range, or luxury?`,
    `- **Origin:** Where are you starting from?`,
    `- **Start time:** What time do you want to leave or begin the trip?`,
    `- **Base stay:** Do you already have a place to stay in ${newName}, or should I recommend one?`,
  ].join("\n");
}

function previousAssistantAskedSwitchInheritance(recent = []) {
  const latestUserIndex = (() => {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (recent[i]?.role === "user") return i;
    }
    return recent.length;
  })();
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (recent[i]?.role !== "assistant") continue;
    const text = String(recent[i].content || "");
    return /\bWant me to reuse your previous setup for this new trip, or start fresh\?/i.test(text);
  }
  return false;
}

function latestSwitchPromptText(recent = []) {
  const latestUserIndex = (() => {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (recent[i]?.role === "user") return i;
    }
    return recent.length;
  })();
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (recent[i]?.role !== "assistant") continue;
    const text = String(recent[i].content || "");
    return /\bWant me to reuse your previous setup for this new trip, or start fresh\?/i.test(text) ? text : "";
  }
  return "";
}

function extractDestinationSwitchPromptField(text = "", label = "") {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`^\\s*-\\s*${escaped}:\\s*(.+?)\\s*$`, "im"));
  return cleanIntakeFieldValue(match?.[1] || "");
}

function extractPendingDestinationSwitch(recent = []) {
  const text = latestSwitchPromptText(recent);
  if (!text) return null;
  const oldMatch = text.match(/Reusable from your\s+(.+?)\s+plan:/i);
  const oldDestination = destinationSwitchDisplayName(oldMatch?.[1] || "");
  let newDestination = "";
  const differentPace = text.match(/^\s*Got it\s+—\s+switching from .+?\.\s+(.+?)\s+is a different pace from/im);
  const rhythm = text.match(/^\s*Got it\s+—\s+switching from .+?\.\s+(.+?)\s+has a very different rhythm/im);
  const moving = text.match(/^\s*Got it\s+—\s+moving over to\s+(.+?)\./im);
  const neutral = text.match(/^\s*Got it\s+—\s+switching from\s+(.+?)\s+to\s+(.+?)\./im);
  if (differentPace?.[1]) newDestination = differentPace[1];
  else if (rhythm?.[1]) newDestination = rhythm[1];
  else if (moving?.[1]) newDestination = moving[1];
  else if (neutral?.[2]) newDestination = neutral[2];

  const duration = extractDestinationSwitchPromptField(text, "Duration");
  const days = Number((duration.match(/\d+/) || [])[0] || 0) || null;
  const inheritedContext = {
    destination: oldDestination,
    date: extractDestinationSwitchPromptField(text, "Dates"),
    days,
    origin: extractDestinationSwitchPromptField(text, "Origin"),
    travelers: extractDestinationSwitchPromptField(text, "Travelers"),
    budget: extractDestinationSwitchPromptField(text, "Budget"),
    startTime: extractDestinationSwitchPromptField(text, "Start"),
  };

  for (const key of Object.keys(inheritedContext)) {
    if (/^to confirm$/i.test(String(inheritedContext[key] || ""))) inheritedContext[key] = "";
  }

  return {
    oldDestination,
    newDestination: destinationSwitchDisplayName(newDestination),
    inheritedContext,
  };
}

function looksLikeSwitchStartFresh(userReply = "") {
  return /^\s*(?:no|nope|nah|start fresh|fresh|new|reset|clear everything|clear it|from scratch)\b/i.test(String(userReply || ""));
}

function looksLikeSwitchReuse(userReply = "") {
  return /^\s*(?:yes|yep|yeah|sure|ok|okay|use it|reuse|keep|same|same data|same details|keep the same details|use the info|use the same info)\b/i.test(String(userReply || ""));
}

function inheritedYearFromDate(value = "") {
  const match = String(value || "").match(/\b(20\d{2}|19\d{2})\b/);
  return match?.[1] || "";
}

function applyInheritedYearToDate(value = "", oldDate = "") {
  const raw = String(value || "").trim();
  if (!raw || /\b(?:20\d{2}|19\d{2})\b/.test(raw)) return raw;
  const year = inheritedYearFromDate(oldDate);
  if (!year) return raw;
  return `${raw.replace(/,\s*$/g, "")}, ${year}`;
}

function parseDestinationSwitchOverrideValue(text = "", field = "", oldContext = {}) {
  const source = String(text || "");
  const corrected = extractCorrectedFieldValue(source, field);
  if (corrected) return field === "date" ? applyInheritedYearToDate(corrected, oldContext.date || oldContext.dates) : corrected;

  if (field === "date") {
    const match = source.match(/\b(?:change|set|move|make)\s+(?:the\s+)?dates?\s+to\s+([^,.!?]+)|\bdates?\s+(?:to|for|is|are)\s+([^,.!?]+)/i);
    const value = cleanTripFactValue(match?.[1] || match?.[2] || "");
    if (value) return applyInheritedYearToDate(value, oldContext.date || oldContext.dates);
    // Fallback: catch natural phrasing like "my flight is in july 22",
    // "i arrive july 22", "we leave on july 22, 2026". Requires BOTH a
    // month name and a day number to avoid false matches like a bare
    // "june" or "this july".
    const naturalMatch = source.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:\s*,\s*(\d{4}))?\b/i);
    if (naturalMatch) {
      const month = naturalMatch[1].charAt(0).toUpperCase() + naturalMatch[1].slice(1).toLowerCase();
      const naturalValue = cleanTripFactValue(`${month} ${naturalMatch[2]}${naturalMatch[3] ? `, ${naturalMatch[3]}` : ""}`);
      return naturalValue ? applyInheritedYearToDate(naturalValue, oldContext.date || oldContext.dates) : "";
    }
    return "";
  }
  if (field === "days") {
    const match = source.match(/\b(?:make\s+(?:it|the\s+duration|duration)|duration\s+(?:is|to|=)?|days?\s+(?:is|are|to|=)?|change\s+(?:the\s+)?duration\s+to|for)\s+(\d{1,2})\s*(?:days?)?(?:\s+only)?\b/i);
    return match?.[1] ? Number(match[1]) : "";
  }
  if (field === "origin") {
    const match = source.match(/\b(?:origin|from|coming from|starting from)\s+(?:is|=|to|as|from)?\s*([\p{L}\p{M}'.\- ]{2,50})/iu);
    return cleanTripFactValue(match?.[1] || "");
  }
  if (field === "travelers") {
    const match = source.match(/\b(?:travelers?|travellers?|with)\s+(?:is|are|=|to|as)?\s*([\p{L}\p{M}'.\- ]{2,50})/iu);
    return cleanTripFactValue(match?.[1] || "");
  }
  if (field === "budget") {
    const match = source.match(/\bbudget\s+(?:is|=|to|as)?\s*([\p{L}\p{M}'.\- ]{2,50})|\bmake it\s+(budget|mid\s*-?\s*range|midrange|luxury|cheap|cheaper)\b/i);
    return cleanTripFactValue(match?.[1] || match?.[2] || "");
  }
  if (field === "startTime") {
    const match = source.match(/\b(?:start(?:\s*time)?|departure)\s+(?:is|=|to|at)?\s*([^,.!?]+)/i);
    return cleanTripFactValue(match?.[1] || "");
  }
  return "";
}

function parseSwitchOverrides(userReply = "", oldContext = {}) {
  const overrides = {};
  const fields = ["date", "days", "travelers", "budget", "origin", "startTime"];
  for (const field of fields) {
    const value = parseDestinationSwitchOverrideValue(userReply, field, oldContext);
    if (value == null || value === "") continue;
    overrides[field] = field === "days" ? Number(value) : value;
  }
  return overrides;
}

function switchRangeStartDate(value = "") {
  const raw = String(value || "").trim();
  const match = raw.match(/^\s*(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:\s*[–—-]\s*\d{1,2})?(?:,\s*(\d{4}))?/i);
  if (!match) return raw;
  return `${match[1].charAt(0).toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[2]}${match[3] ? `, ${match[3]}` : ""}`;
}

async function applyDestinationSwitchDefaults(tripContext = {}) {
  // Hardcoded Bantayan→"Santa Fe" base and Japan→"Tokyo/Shinjuku" base
  // injections were removed so this works for every destination
  // worldwide. The base area, transport mode, and start time now come
  // from what the user actually provides or what the providers
  // (map provider/free geocoder/map provider/place search) resolve — no built-in bias.
  const next = { ...tripContext };
  const country = await destinationSwitchCountry(next.destination);
  if (country && !next.country) next.country = country;
  return next;
}

async function applyDestinationSwitchInheritance(oldContext = {}, userReply = "", newDestination = "") {
  const destination = destinationSwitchDisplayName(newDestination);
  const country = await destinationSwitchCountry(destination);
  const baseFresh = {
    destination,
    country,
    date: "",
    days: null,
    travelers: "",
    budget: "",
    origin: "",
    startTime: "",
    subArea: "",
    baseArea: "",
    hotelArea: "",
    noHotelYet: false,
    transportMode: "",
    pendingEdits: [],
    specialRequests: [],
    preTripTravel: "",
    overnightBase: "",
    itineraryStartPoint: "",
    itineraryStartTime: "",
    activeItineraryText: "",
  };

  if (looksLikeSwitchStartFresh(userReply)) {
    return {
      tripContext: await applyDestinationSwitchDefaults(baseFresh),
      mode: "fresh",
      inheritedCount: 0,
      overrideCount: 0,
      overrideFields: [],
    };
  }

  const inheritable = {};
  for (const field of DESTINATION_SWITCH_INHERIT_FIELDS) {
    const value = oldContext[field];
    if (value == null || value === "" || /^to confirm$/i.test(String(value))) continue;
    inheritable[field] = value;
  }

  const overrides = parseSwitchOverrides(userReply, oldContext);
  if (overrides.days && inheritable.date && !overrides.date) {
    inheritable.date = switchRangeStartDate(inheritable.date);
  }
  const tripContext = await applyDestinationSwitchDefaults({
    ...baseFresh,
    ...inheritable,
    ...overrides,
  });
  // Bug 3 fix: pull special requests out of the same user reply that
  // confirmed the switch (e.g. "yes use that and i want to visit churches
  // and a must-visit landmark in the same destination"). Without this, the first generation
  // drops them and the user has to repeat themselves.
  const newSpecialRequests = uniqueIntakeLabels([
    ...(await extractKnownMustVisitsFromText(userReply, { tripContext })),
  ]);
  if (newSpecialRequests.length) {
    tripContext.specialRequests = newSpecialRequests;
  }
  await maybeInferTransportModeFromRoute(tripContext);
  tripContext.essentialsComplete = recomputeTripEssentialsComplete(tripContext);

  return {
    tripContext,
    mode: looksLikeSwitchReuse(userReply) || Object.keys(overrides).length ? "reuse" : "reuse",
    inheritedCount: Object.keys(inheritable).length,
    overrideCount: Object.keys(overrides).length,
    overrideFields: Object.keys(overrides),
  };
}

function buildTripSwitchFreshDetailsQuestion(tripContext = {}) {
  const fields = [];
  fields.push(["Date/month", "When is this new trip?"]);
  fields.push(["Travelers", "Who is this trip for?"]);
  fields.push(["Budget", "Budget, mid-range, or luxury?"]);
  fields.push(["Origin", "Where are you coming from?"]);
  if (!tripContext.startTime) fields.push(["Start time", "Morning, afternoon, or evening?"]);
  if (!tripContext.transportMode) fields.push(["Transport mode", "Car, public transport, or something else?"]);

  return [
    "No problem. I’ll treat this as a separate trip.",
    "",
    "I need the new trip details first:",
    ...fields.slice(0, 4).map(([label, question]) => `- **${label}:** ${question}`),
  ].join("\n");
}

function buildTripSwitchBaseQuestion(tripContext = {}) {
  const destination = formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext);
  const baseQuestion = buildBaseAreaQuestionForDestination(tripContext);
  return [
    `Okay, I’ll use those same settings for **${destination}**.`,
    "",
    "One new detail for this separate trip:",
    `- **Base area:** ${baseQuestion}`,
  ].join("\n");
}

function needsTripSwitchInheritanceConfirmation(parsed = {}, recent = [], reply = "") {
  const latestUser = getLatestUserText(recent);
  if (latestUserStartsFreshDestinationContext(latestUser)) return null;
  if (!latestUserStartsNewTripRequest(latestUser)) return null;
  if (latestUserProvidesFullNewTripSettings(latestUser)) return null;
  if (previousAssistantAskedInheritanceConfirmation(recent)) return null;
  if (latestUserExplicitlyAcceptsInheritance(latestUser) || latestUserExplicitlyRejectsInheritance(latestUser)) return null;

  const previous = extractLatestTripContextForInheritance(recent);
  if (!previous?.context) return null;
  const priorDest = normalizeIntakePlace(formatIntakeDestination(previous.context));
  const nextDest = normalizeIntakePlace(formatIntakeDestination(parsed.tripContext || {}) || getIntakeDestinationLabel(parsed.tripContext || {}));
  if (!nextDest || !priorDest || nextDest === priorDest || priorDest.includes(nextDest) || nextDest.includes(priorDest)) {
    return null;
  }

  const text = String(reply || parsed.replyText || "");
  if (/Should I use the same trip settings as your previous/i.test(text)) return null;
  return previous;
}

function mergePriorBlueprintContext(tripContext = {}, prior = null, { force = false } = {}) {
  if (!prior || typeof prior !== "object") return { ...tripContext };
  const merged = { ...tripContext };
  const fields = [
    "destination",
    "subArea",
    "country",
    "days",
    "date",
    "travelers",
    "budget",
    "theme",
    "origin",
    "startTime",
    "preTripTravel",
    "overnightBase",
    "itineraryStartDate",
    "itineraryStartTime",
    "itineraryStartPoint",
    "transportMode",
    "baseArea",
    "accommodationBudget",
    "selectedHotel",
    "hotelArea",
    "hotelStatus",
    "noHotelYet",
    "breakfastIncluded",
    "breakfastNote",
    "specialRequests",
  ];

  for (const field of fields) {
    if (prior[field] == null || prior[field] === "") continue;
    if (field === "specialRequests") {
      merged.specialRequests = uniqueIntakeLabels([
        ...(Array.isArray(prior.specialRequests) ? prior.specialRequests : []),
        ...(Array.isArray(merged.specialRequests) ? merged.specialRequests : []),
      ]);
      continue;
    }
    const current = merged[field];
    const shouldUsePrior =
      force ||
      current == null ||
      current === "" ||
      (typeof current === "string" && isWeakContextValue(field, current));
    if (shouldUsePrior) merged[field] = prior[field];
  }

  return merged;
}

function destinationLockFromResolved(resolved = null) {
  const label = cleanTripFactValue(resolved?.destination || "");
  if (!label) return null;
  return {
    key: normalizeIntakePlace(label),
    label,
    country: cleanTripFactValue(resolved?.country || ""),
    formatted: cleanTripFactValue(resolved?.formatted || ""),
  };
}

async function resolveDestinationLockCandidate(text = "") {
  const resolved = await resolveKnownIntakeDestinationFromText(text);
  if (resolved?.destination) return destinationLockFromResolved(resolved);
  const direct = cleanProviderDestinationPhrase(text);
  if (!direct) return null;
  return destinationLockFromResolved(await resolveIntakeDestinationCandidate(direct));
}

function destinationLockMatchesKey(placeKey = "", lock = null) {
  if (!lock) return false;
  const key = normalizeIntakePlace(placeKey);
  const lockKey = normalizeIntakePlace(lock.label);
  const formattedKey = normalizeIntakePlace(lock.formatted || "");
  if (!key || !lockKey) return false;
  if (key === lockKey) return true;
  if (key.length >= 4 && lockKey.includes(key)) return true;
  if (lockKey.length >= 4 && key.includes(lockKey)) return true;
  return Boolean(formattedKey && lockKey.length >= 4 && formattedKey.includes(lockKey) && formattedKey.includes(key));
}

function escapeIntakeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function baseRemainderFromLockedDestination(value = "", lock = null) {
  const raw = cleanTripFactValue(value);
  const lockLabel = cleanTripFactValue(lock?.label || "");
  if (!raw || !lockLabel) return "";
  let remainder = raw.replace(new RegExp(`\\b${escapeIntakeRegExp(lockLabel)}\\b`, "i"), " ");
  if (remainder === raw) {
    const first = lockLabel.split(/\s+/).find(Boolean);
    if (first && new RegExp(`^\\s*${escapeIntakeRegExp(first)}\\b`, "i").test(raw)) {
      remainder = raw.replace(new RegExp(`^\\s*${escapeIntakeRegExp(first)}\\b`, "i"), " ");
    }
  }
  remainder = cleanTripFactValue(remainder.replace(/^[,/\-\s]+|[,/\-\s]+$/g, ""));
  if (!remainder || /^(?:city|island|province|country|region)$/i.test(remainder)) return "";
  return remainder;
}

// Extract the locked destination from the user's first provider-backed
// trip-planning message so later messages cannot silently overwrite it.
async function extractLockedDestinationFromHistory(recent = []) {
  let startIndex = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    if (turn?.role !== "user") continue;
    const previousAssistant = i > 0 ? recent[i - 1] : null;
    const freshDestinationStart =
      latestUserStartsFreshDestinationContext(turn.content) &&
      !(
        i > 0 &&
        latestUserAddsMustVisitWithoutDestinationOverride(turn.content) &&
        !/\b(?:trip|itinerary|plan|new\s+trip|start\s+fresh|switch)\b/i.test(String(turn.content || ""))
      );
    if (
      latestUserRequestsTripReset(turn.content) ||
      freshDestinationStart ||
      (
        previousAssistant?.role === "assistant" &&
        extractDestinationFromAmbiguousIslandConfirmation(turn.content, previousAssistant.content)
      )
    ) {
      startIndex = i;
      break;
    }
  }
  const userMessages = (recent || [])
    .slice(startIndex)
    .filter((m) => m && m.role === "user" && m.content);
  for (const msg of userMessages) {
    const rawText = String(msg.content || "");
    const corrected = extractCorrectedDestinationFromComplaint(rawText);
    if (!corrected) continue;
    const lock = await resolveDestinationLockCandidate(corrected);
    if (lock) return lock;
  }
  for (const msg of userMessages) {
    const rawText = String(msg.content || "");
    const text = normalizeIntakeDestinationTypos(rawText).toLowerCase();
    if (
      !/\b(?:plan|trip|itinerary|visit|go to|travel to|day trip|days? trip|tour|destination|asked about|reply about|replied about|switching to|switch to)\b/.test(text) &&
      !previousAssistantAskedAmbiguousIslandClarification(recent)
    ) continue;
    const lock = await resolveDestinationLockCandidate(rawText);
    if (lock) return lock;
  }
  for (let i = 0; i < recent.length; i += 1) {
    const turn = recent[i];
    if (turn?.role !== "assistant") continue;
    const text = normalizeIntakeDestinationTypos(String(turn.content || ""));
    const match = text.match(/\bswitch(?:ing)?\s+to\s+([^.\n]+)/i);
    if (!match?.[1]) continue;
    const lock = await resolveDestinationLockCandidate(match[1]);
    if (lock) return lock;
  }
  return null;
}

function applyDestinationLock(tripContext = {}, lock = null) {
  if (!tripContext || !lock) return tripContext;
  const currentDestKey = normalizeIntakePlace(tripContext.destination || "");
  const currentSubKey = normalizeIntakePlace(tripContext.subArea || "");
  const lockKey = normalizeIntakePlace(lock.label);
  if (destinationLockMatchesKey(currentDestKey, lock) && currentDestKey !== lockKey) {
    const baseRemainder = baseRemainderFromLockedDestination(tripContext.destination, lock);
    if (baseRemainder && !tripContext.baseArea) {
      tripContext.baseArea = canonicalKnownBaseAreaForIntake(baseRemainder) || titleCaseIntakeValue(baseRemainder);
    }
    tripContext.destination = lock.label;
    tripContext.country = tripContext.country || lock.country;
  }
  // If destination got reassigned away from the provider-backed lock,
  // restore it. This prevents origin/base mentions from becoming the trip
  // destination late in intake.
  const matchesLock = (k) => destinationLockMatchesKey(k, lock);
  if (currentDestKey && !matchesLock(currentDestKey)) {
    tripContext.destination = lock.label;
    if (!matchesLock(currentSubKey)) {
      tripContext.subArea = "";
    }
    tripContext.country = tripContext.country || lock.country;
  }
  // If destination is still empty but lock is known, set it.
  if (!currentDestKey && lock.label) {
    tripContext.destination = lock.label;
    tripContext.country = tripContext.country || lock.country;
  }
  return tripContext;
}

async function normalizeTripContextForLatestUser(parsed = {}, recent = []) {
  const latestUser = getLatestUserText(recent);
  const original = parsed.tripContext || {};
  const priorBlueprint = extractLatestBlueprintContext(recent);
  const ambiguousDestinationConfirmed = previousAssistantAskedAmbiguousIslandClarification(recent) &&
    /\b(?:camiguin|manjuyod)\b/i.test(latestUser);
  // A destination-correction complaint ("the destination should be camiguin,
  // not cebu") is a correction, NOT a fresh trip. We must preserve the prior
  // blueprint (dates, travelers, budget, origin, base, must-visits) and only
  // overwrite the destination. A true fresh switch ("new trip to <X>",
  // "switch to <X>") still wipes context as before.
  const correctedComplaintDestination = extractCorrectedDestinationFromComplaint(latestUser);
  const isComplaintCorrection = Boolean(correctedComplaintDestination);
  const accommodationFollowup = latestUserRequestsAccommodationRecommendations(latestUser);
  const freshDestinationSwitch =
    !isComplaintCorrection &&
    !accommodationFollowup && (
      latestUserStartsFreshDestinationContext(latestUser) ||
      ambiguousDestinationConfirmed
    );
  const resetRequested = latestUserRequestsTripReset(latestUser) || freshDestinationSwitch;
  const correctionRequested =
    latestUserLooksLikeTripCorrection(latestUser) || isComplaintCorrection;
  const lockedDestination = resetRequested ? null : await extractLockedDestinationFromHistory(recent);
  const pendingBlueprintRevision =
    Boolean(priorBlueprint) &&
    !latestUserBypassesPendingBlueprintRevision(latestUser) &&
    latestUserLooksLikePendingBlueprintRevision(latestUser);
  const recentFacts = await extractTripFactsFromUserText(recentUserTextForTripFacts(recent, latestUser));
  const latestFacts = await extractTripFactsFromUserText(latestUser);
  const preserveBroadDestinationForMustVisit =
    lockedDestinationIsBroad(lockedDestination) &&
    latestUserAddsMustVisitWithoutDestinationOverride(latestUser);
  if (preserveBroadDestinationForMustVisit) {
    latestFacts.destination = null;
    latestFacts.subArea = null;
    if (recentFacts.destination && !destinationLockMatchesKey(normalizeIntakePlace(recentFacts.destination), lockedDestination)) {
      recentFacts.destination = lockedDestination.label;
      recentFacts.country = lockedDestination.country || recentFacts.country || "";
      recentFacts.subArea = null;
    }
  }
  const priorUserTurnsBeforeLatest = [...recent].slice(0, -1).filter((turn) => turn?.role === "user");
  const previousUserBeforeLatest = priorUserTurnsBeforeLatest[priorUserTurnsBeforeLatest.length - 1];
  const shouldCarryPendingFreshDestination =
    !latestFacts.destination &&
    (
      latestUserRequestsTripReset(latestUser) ||
      latestUserRequestsTripReset(previousUserBeforeLatest?.content || "")
    );
  if (shouldCarryPendingFreshDestination) {
    const priorFresh = priorUserTurnsBeforeLatest
      .slice(0, latestUserRequestsTripReset(previousUserBeforeLatest?.content || "") ? -1 : undefined)
      .reverse()
      .find((turn) => latestUserStartsFreshDestinationContext(turn.content));
    const priorFreshFacts = priorFresh ? await extractTripFactsFromUserText(priorFresh.content) : {};
    for (const field of ["destination", "subArea", "country", "days", "baseArea", "transportMode", "startTime"]) {
      if (latestFacts[field] == null || latestFacts[field] === "") {
        latestFacts[field] = priorFreshFacts[field];
      }
    }
  }
  if (ambiguousDestinationConfirmed && !latestFacts.destination) {
    latestFacts.destination = /\bmanjuyod\b/i.test(latestUser) ? "Manjuyod" : "Camiguin";
    latestFacts.country = "Philippines";
  }
  if (isComplaintCorrection && !latestFacts.destination) {
    latestFacts.destination = correctedComplaintDestination;
    latestFacts.country = "Philippines";
  }
  let tripContext = resetRequested
    ? createBlankTripContext()
    : mergePriorBlueprintContext(
        { ...original },
        priorBlueprint,
        { force: pendingBlueprintRevision && !correctionRequested }
      );
  tripContext = applyTripFacts(tripContext, recentFacts, { overwrite: resetRequested });
  tripContext = applyTripFacts(tripContext, latestFacts, { overwrite: resetRequested || correctionRequested });
  tripContext = sanitizeTripContextForIntake(tripContext, recentFacts, latestFacts);
  // Worldwide-safe scrub: drop any specialRequests entry whose significant
  // tokens have NO support in the user's conversation history. Catches LLM
  // injection of unrelated entities (e.g. "Glencore", "Ag", random corporate
  // names) into the trip's specialRequests field.
  tripContext = scrubUnsupportedSpecialRequests(tripContext, recent);
  if (
    !tripContext.startTime &&
    priorBlueprint?.startTime &&
    (correctionRequested || pendingBlueprintRevision || latestUserRequestsTripSummary(latestUser))
  ) {
    tripContext.startTime = priorBlueprint.startTime;
  }
  // DESTINATION LOCK: once the user has clearly named a destination in
  // their first trip-planning message, do not let later "Cebu/origin" or
  // base mentions overwrite it.
  tripContext = applyDestinationLock(tripContext, lockedDestination);
  if (isComplaintCorrection && /\bsanta\s+fe\b|\bsta\.?\s*fe\b/i.test(correctedComplaintDestination)) {
    tripContext.destination = "Bantayan Island";
    tripContext.subArea = "Santa Fe";
    tripContext.country = tripContext.country || "Philippines";
    tripContext.baseArea = /santa\s+fe|kota\s+beach|bantayan/i.test(String(priorBlueprint?.baseArea || ""))
      ? priorBlueprint.baseArea
      : "Santa Fe town center / near Kota Beach";
    tripContext.noHotelYet = tripContext.selectedHotel ? false : true;
    tripContext.hotelStatus = tripContext.selectedHotel ? "selected" : "needs_recommendation";
  }
  const latestSpecific = pendingBlueprintRevision || resetRequested || latestFacts.destination ? "" : extractSpecificDestinationFromLatestUser(latestUser);
  const latestOrigin = extractOriginFromLatestUser(latestUser) || extractBareOriginFromLatestUser(latestUser, tripContext);
  const latestStart = extractStartTimeFromLatestUser(latestUser);
  const recentTripBudget = resetRequested
    ? extractRecentTripBudgetTier([{ role: "user", content: latestUser }])
    : extractRecentTripBudgetTier(recent);
  const userProvidedBudget = resetRequested
    ? userMessageHasExplicitTripBudget(latestUser)
    : recentUserProvidedOrAcceptedTripBudget(recent);
  const budgetAcceptedFromPrior =
    (pendingBlueprintRevision && Boolean(priorBlueprint?.budget)) ||
    (correctionRequested && Boolean(priorBlueprint?.budget)) ||
    (latestUserRequestsTripSummary(latestUser) && Boolean(priorBlueprint?.budget)) ||
    (previousAssistantAskedInheritanceConfirmation(recent) && latestUserExplicitlyAcceptsInheritance(latestUser));
  const destinationKey = normalizeIntakePlace(tripContext.destination);
  const subAreaKey = normalizeIntakePlace(tripContext.subArea);

  if (latestSpecific && !/\bpalawan\b/i.test(latestSpecific)) {
    const latestSpecificKey = normalizeIntakePlace(latestSpecific);
    const lockKey = lockedDestination ? normalizeIntakePlace(lockedDestination.label) : "";
    const lockParentKey = lockedDestination?.parent ? normalizeIntakePlace(lockedDestination.parent) : "";
    const insideLock =
      lockedDestination &&
      (latestSpecificKey === lockKey ||
        latestSpecificKey === lockParentKey ||
        lockKey.includes(latestSpecificKey) ||
        latestSpecificKey.includes(lockKey) ||
        (lockParentKey && (lockParentKey.includes(latestSpecificKey) || latestSpecificKey.includes(lockParentKey))));
    if (!lockedDestination || insideLock) {
      if (!tripContext.subArea || destinationKey === "palawan" || destinationKey === "palawan philippines" || !subAreaKey) {
        tripContext.subArea = latestSpecific;
      }
      if (!tripContext.destination || normalizeIntakePlace(tripContext.destination) === normalizeIntakePlace(latestSpecific)) {
        tripContext.destination = latestSpecific;
      }
      if (/\bel nido\b/i.test(latestSpecific)) {
        tripContext.destination = "Palawan";
        tripContext.subArea = "El Nido";
        tripContext.country = tripContext.country || "Philippines";
        if (!tripContext.hotelArea && /(?:no|don't|dont)\s+have\s+(?:a\s+)?(?:place|hotel|stay)|recommend/i.test(latestUser)) {
          tripContext.hotelArea = "El Nido town proper, near the beach/port area";
        }
      }
    } else {
      // Locked destination already set (e.g. Bohol). The latestSpecific value
      // came from a base-area answer like "tagbilaran" — treat it as the
      // base area, NOT a new destination.
      if (!tripContext.baseArea) {
        tripContext.baseArea = `${latestSpecific}${lockedDestination.parent ? `, ${lockedDestination.parent}` : ""}`;
        tripContext.noHotelYet = tripContext.noHotelYet === true ? true : false;
      }
    }
  }

  if (
    preserveBroadDestinationForMustVisit
  ) {
    tripContext.destination = lockedDestination.label;
    tripContext.country = tripContext.country || lockedDestination.country;
    tripContext.subArea = priorBlueprint?.subArea || "";
  }

  if (latestOrigin) {
    // Never assign origin a value that equals the locked destination.
    // "tagbilaran, cebu" sent after destination is locked to Bohol should
    // set origin = Cebu and base = Tagbilaran, not destination = Cebu.
    const originKey = normalizeIntakePlace(latestOrigin);
    const lockKey = lockedDestination ? normalizeIntakePlace(lockedDestination.label) : "";
    const lockParentKey = lockedDestination?.parent ? normalizeIntakePlace(lockedDestination.parent) : "";
    if (!lockedDestination || (originKey !== lockKey && originKey !== lockParentKey)) {
      tripContext.origin = latestOrigin;
    }
  } else if (/\bwe\s+want\b/i.test(String(tripContext.origin || ""))) {
    tripContext.origin = "";
  }

  // Re-apply destination lock after latest extractions so the final state
  // always matches the originally-locked destination.
  applyDestinationLock(tripContext, lockedDestination);

  if (latestStart && !tripContext.itineraryStartTime) {
    tripContext.startTime = /\bflight\b/i.test(latestUser) ? `${latestStart} flight departure` : latestStart;
  }
  const explicitTransportFromLatest = extractExplicitTransportModeFromText(latestUser);
  const userExplicitTransport = Boolean(explicitTransportFromLatest) ||
    /\bflight\b|\bplane\b|\bfly(?:ing)?\b|\bairport\b/i.test(latestUser) ||
    /\bferr(?:y|ies)\b|\bpier\b|\bboat\b/i.test(latestUser);
  if (/\bflight\b|\bplane\b|\bfly(?:ing)?\b|\bairport\b/i.test(latestUser)) {
    tripContext.transportMode = "flight + local transfer";
  } else if (/\bferr(?:y|ies)\b|\bpier\b|\bboat\b/i.test(latestUser)) {
    tripContext.transportMode = "ferry + local transfer";
  } else if (explicitTransportFromLatest && !tripContext.transportMode) {
    tripContext.transportMode = explicitTransportFromLatest;
  } else if (
    !String(tripContext.transportMode || "").trim() &&
    /\bcebu\b/i.test(String(tripContext.origin || "")) &&
    /\b(?:bohol|panglao|tagbilaran|alona|dauis|dumaluan)\b/i.test(
      `${tripContext.subArea || ""} ${tripContext.destination || ""} ${tripContext.country || ""}`
    )
  ) {
    // Cebu → Bohol/Panglao: default to ferry (NOT flight). Users overwhelmingly
    // take the fast ferry from Cebu Pier to Tagbilaran rather than the short
    // hop via Bohol-Panglao airport.
    tripContext.transportMode = "ferry + local transfer";
  }
  // Cebu → Camiguin: force the schedule-dependent label even if the LLM
  // already wrote "flight + local transfer". There is no daily direct Cebu
  // → Camiguin flight — the realistic route is flight to CDO + ferry, or
  // ferry direct from CDO/Balingoan. Only the user explicitly saying
  // "flight" or "ferry" overrides this.
  if (
    !userExplicitTransport &&
    /\bcebu\b/i.test(String(tripContext.origin || "")) &&
    /\bcamiguin\b/i.test(`${tripContext.subArea || ""} ${tripContext.destination || ""} ${tripContext.country || ""}`)
  ) {
    tripContext.transportMode = "Cebu → Cagayan de Oro flight or sea connection, then ferry to Camiguin (verify current schedules) + local transfer";
  }
  if (!userExplicitTransport && (!String(tripContext.transportMode || "").trim() || isGenericTransportMode(tripContext.transportMode))) {
    const defaultedTransport = defaultTransportModeForTrip(tripContext);
    if (defaultedTransport) tripContext.transportMode = defaultedTransport;
  }
  if (recentTripBudget && (/\b(?:per\s+night|\/night|hotel|hostel|place\s+to\s+stay|accommodation)\b/i.test(latestUser) || !tripContext.budget || /^budget$/i.test(tripContext.budget))) {
    tripContext.budget = recentTripBudget;
  }
  if (
    tripContext.noHotelYet === true &&
    !tripContext.baseArea &&
    isBantayanIntakeTrip(tripContext, recentUserTextForTripFacts(recent, latestUser))
  ) {
    tripContext.baseArea = "Santa Fe town center / near Kota Beach";
    tripContext.baseStatus = tripContext.baseStatus || "recommend";
  }
  if (
    (latestUserRequestsAccommodationRecommendations(latestUser) || previousUserRequestedAccommodationRecommendations(recent)) &&
    isBantayanIntakeTrip(tripContext, recentUserTextForTripFacts(recent, latestUser)) &&
    !String(tripContext.selectedHotel || "").trim() &&
    (
      !String(tripContext.baseArea || "").trim() ||
      /^Santa\s+Fe,\s*Bantayan\s+Island$/i.test(String(tripContext.baseArea || "").trim())
    )
  ) {
    tripContext.baseArea = "Santa Fe town center / near Kota Beach";
    tripContext.baseStatus = "recommend";
    tripContext.noHotelYet = true;
  }
  if (
    tripContext.noHotelYet === true &&
    !tripContext.baseArea &&
    /\bbaguio\b/i.test(formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext))
  ) {
    tripContext.baseArea = "Session Road / Burnham Park / City Center";
  }
  if (
    !tripContext.baseArea
  ) {
    const conversationText = (recent || []).filter((turn) => turn?.role === "user").map((turn) => String(turn.content || "")).join(" ");
    const conversationBase = canonicalKnownBaseAreaForIntake(conversationText);
    if (conversationBase && /\bsession\s+road\b/i.test(conversationBase) && /\bbaguio\b/i.test(`${conversationText} ${formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext)}`)) {
      tripContext.baseArea = conversationBase;
    }
  }
  if (
    tripContext.noHotelYet === true &&
    !tripContext.baseArea &&
    /\bcamiguin\b/i.test(formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext))
  ) {
    tripContext.baseArea = "Mambajao / Yumbing";
  }
  // Siargao base capture: when the user named "General Luna" / "Gen Luna" /
  // "GL" / "Cloud 9" / "Tourism Road" in the conversation, save it as the
  // base. Previously the geocoder hit on "General Luna" but the value
  // wasn't persisted into tripContext.baseArea, so the assistant kept
  // re-asking the same base question.
  if (
    !tripContext.baseArea &&
    /\bsiargao\b/i.test(`${tripContext.subArea || ""} ${tripContext.destination || ""} ${tripContext.country || ""}`)
  ) {
    const siargaoConversationText = (recent || [])
      .filter((turn) => turn?.role === "user")
      .map((turn) => String(turn.content || ""))
      .join(" ");
    const siargaoBaseMatch =
      siargaoConversationText.match(/\b(?:cloud\s*9|cloud-9|tourism\s+road)\b/i) ||
      siargaoConversationText.match(/\b(?:gen(?:eral)?\s+luna|gen\s*luna|gl)\b/i) ||
      siargaoConversationText.match(/\bcatangnan\b/i);
    if (siargaoBaseMatch) {
      const matched = String(siargaoBaseMatch[0] || "").toLowerCase();
      if (/cloud/.test(matched)) tripContext.baseArea = "Cloud 9 / Catangnan";
      else if (/tourism/.test(matched)) tripContext.baseArea = "Tourism Road, General Luna";
      else if (/catangnan/.test(matched)) tripContext.baseArea = "Cloud 9 / Catangnan";
      else tripContext.baseArea = "General Luna";
      tripContext.baseStatus = tripContext.baseStatus || "provided";
      if (tripContext.noHotelYet === true) tripContext.noHotelYet = false;
    }
  }
  // For Bohol trips without a chosen base, prefer the sub-area the user
  // actually named (Tagbilaran / Loboc / Anda / Panglao / Alona) over a
  // hardcoded default. Only fall back to Panglao / Alona when the user
  // gave no sub-area hint anywhere in the conversation — otherwise we
  // overrode user intent in the previous build.
  if (
    tripContext.noHotelYet === true &&
    !tripContext.baseArea &&
    /\b(?:panglao|bohol|alona|dumaluan|tagbilaran|loboc|anda|dauis)\b/i.test(
      formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext)
    )
  ) {
    const userBoholBase =
      canonicalBoholBaseAreaForIntake(tripContext.subArea || "") ||
      canonicalBoholBaseAreaForIntake(
        recentUserTextForTripFacts(recent, latestUser)
      );
    if (userBoholBase) tripContext.baseArea = userBoholBase;
    // No silent default — when the user truly never named a base, leave
    // baseArea empty so the assistant asks rather than picking Panglao.
  }
  // Compose the user's explicitly selected hotel + base area into a single
  // Hotel/base label. We persist selectedHotel separately so future turns
  // (after concat) can re-compose without depending on the LLM remembering
  // it. The destination MUST NOT change here — this is just the lodging
  // choice for the active destination.
  const selectedHotel = String(tripContext.selectedHotel || "").trim();
  if (selectedHotel) {
    if (!tripContext.baseArea) {
      const recommendedBase = accommodationRecommendationBaseFromRecent(recent);
      if (recommendedBase) {
        tripContext.baseArea = canonicalKnownBaseAreaForIntake(recommendedBase) || titleCaseIntakeValue(recommendedBase);
      }
    }
    const baseAreaLabel = String(tripContext.baseArea || "").trim();
    tripContext.hotelArea = formatSelectedHotelBaseLabelForIntake(selectedHotel, baseAreaLabel);
    // Once a hotel is picked, the trip is no longer "no hotel yet".
    if (tripContext.noHotelYet === true) tripContext.noHotelYet = false;
    tripContext.hotelStatus = "selected";
  } else if (tripContext.noHotelYet === true) {
    tripContext.hotelStatus = "needs_recommendation";
  } else if (tripContext.baseArea || tripContext.hotelArea) {
    tripContext.hotelStatus = tripContext.hotelStatus || "base_area_selected";
  }

  // Hard guard: never let must-visit attractions become the destination/subArea.
  const mustVisitOnly = /\b(?:landmark|cave|river|falls?|park|volcano|lake|museum|temple|shrine|church|cathedral|sanctuary|viewpoint|disneyland|theme\s*park)\b/i;
  for (const field of ["destination", "subArea", "baseArea"]) {
    const value = String(tripContext[field] || "").trim();
    if (value && mustVisitOnly.test(value.replace(/\s*too\s*$/i, "").trim())) {
      // demote to special request and clear from this field
      const requests = Array.isArray(tripContext.specialRequests) ? tripContext.specialRequests : [];
      if (!requests.some((r) => normalizeIntakePlace(r) === normalizeIntakePlace(value))) {
        requests.push(value.replace(/\s*too\s*$/i, "").trim());
      }
      tripContext.specialRequests = uniqueIntakeLabels(requests);
      tripContext[field] = "";
    }
  }
  await applySpecialRequestCorrectionToTripContext(tripContext, latestUser);
  if (!tripContext.budget && (recentTripBudget || budgetAcceptedFromPrior)) {
    tripContext.budget = recentTripBudget || tripContext.budget;
  }

  // Style inference: if the style is empty or "General travel" but the
  // conversation/special-requests/travelers clearly point to a theme,
  // upgrade the style label instead of leaving the bland default.
  tripContext.style = inferStyleLabel(tripContext, recent);
  await maybeInferTransportModeFromRoute(tripContext);
  // Canonical date sync: collapse any date format the LLM/regex left behind
  // ("May 19", "May 19–21, 2026", "may 2027") into a single ISO start date
  // (YYYY-MM-DD). The blueprint renderer (formatIntakeDateRange) and the
  // itinerary builder both work from this same field, so a normalized value
  // here keeps the visible summary and the itinerary header in sync.
  try {
    const rawDate = String(tripContext.date || "").trim();
    if (rawDate && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(rawDate)) {
      const todayISO = String(parsed?.appContext?.todayISO || "").trim();
      // 1. ISO already present somewhere ("2027-05-19 to 2027-05-21") — pick the first.
      const isoEmbedded = rawDate.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
      // 2. Range form "Month D–D, YYYY" — pick the start day + year.
      const rangeForm = rawDate.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\s*[–—-]\s*\d{1,2}(?:,\s*(\d{4}))?\b/i);
      // 3. Single date "Month D, YYYY" or "Month D".
      const singleForm = rawDate.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\b/i);
      const monthIdxOf = (name) => {
        const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
        const key = String(name || "").toLowerCase().slice(0, 3);
        const idx = months.indexOf(key);
        return idx >= 0 ? idx + 1 : 0;
      };
      const inferYear = (month, day) => {
        const now = todayISO.match(/^(\d{4})-(\d{2})-(\d{2})$/)
          ? new Date(`${todayISO}T12:00:00Z`)
          : new Date();
        let year = now.getUTCFullYear();
        const todayMonth = now.getUTCMonth() + 1;
        const todayDay = now.getUTCDate();
        if (month * 100 + day <= todayMonth * 100 + todayDay) year += 1;
        return year;
      };
      let isoResult = "";
      if (isoEmbedded) {
        isoResult = `${isoEmbedded[1]}-${String(Number(isoEmbedded[2])).padStart(2, "0")}-${String(Number(isoEmbedded[3])).padStart(2, "0")}`;
      } else if (rangeForm) {
        const month = monthIdxOf(rangeForm[1]);
        const day = Number(rangeForm[2]);
        const yr = Number(rangeForm[3] || 0) || inferYear(month, day);
        if (month && Number.isFinite(day)) {
          isoResult = `${yr}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        }
      } else if (singleForm) {
        const month = monthIdxOf(singleForm[1]);
        const day = Number(singleForm[2]);
        const yr = Number(singleForm[3] || 0) || inferYear(month, day);
        if (month && Number.isFinite(day)) {
          isoResult = `${yr}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        }
      }
      if (isoResult) tripContext.date = isoResult;
    }
  } catch (e) {
    console.warn("[intake] date normalizer failed:", String(e?.message || e || ""));
  }
  // Final country lock: if any earlier step left a wrong country for a
  // known destination (free geocoder "Cebu" → Italy/UK/US micro-place), force
  // the correct country back in based on the destination/sub-area we ended
  // up with. The user's explicit country statement still wins (handled
  // upstream in applyTripUnderstandingToMerged via
  // extractExplicitCountryFromUserText).
  try {
    const destName = String(tripContext.destination || tripContext.subArea || "").trim();
    if (destName && typeof inferCountryForKnownDestination === "function") {
      const knownCountry = inferCountryForKnownDestination(destName);
      if (knownCountry && tripContext.country !== knownCountry) {
        const userExplicitCountry = typeof extractExplicitCountryFromUserText === "function"
          ? extractExplicitCountryFromUserText(latestUser || "")
          : "";
        if (!userExplicitCountry || userExplicitCountry === knownCountry) {
          tripContext.country = knownCountry;
        }
      }
    }
  } catch (e) {
    console.warn("[intake] country lock guard failed:", String(e?.message || e || ""));
  }
  console.log("[intake] post-merge tripContext", {
    destination: tripContext.destination || tripContext.subArea || null,
    country: tripContext.country || null,
    days: tripContext.days || null,
    date: tripContext.date || null,
    travelers: tripContext.travelers || null,
    budget: tripContext.budget || null,
    origin: tripContext.origin || null,
    startTime: tripContext.startTime || null,
    base: tripContext.baseArea || (tripContext.noHotelYet ? "noHotelYet" : null),
    essentialsComplete: tripContext.essentialsComplete,
  });
  tripContext.essentialsComplete = recomputeTripEssentialsComplete(tripContext);

  return {
    ...parsed,
    tripContext,
    pendingEdits: resetRequested || correctionRequested
      ? []
      : pendingBlueprintRevision
      ? [
          ...(Array.isArray(parsed.pendingEdits) ? parsed.pendingEdits : []),
          await normalizePendingBlueprintEdit(latestUser, { tripContext }),
        ].filter(Boolean)
      : parsed.pendingEdits,
  };
}

function shouldReplaceMalformedBlueprintReply(reply = "") {
  const text = String(reply || "").trim();
  if (!looksLikeBlueprintReply(text)) return false;
  if (/\bWe Want\b/i.test(text)) return true;
  if (/Destination:[^\n]+Origin:[^\n]+Dates:[^\n]+Duration:/i.test(text)) return true;
  if (/Here's the trip summary:/i.test(text) && !/- \*\*Destination:\*\*/.test(text)) return true;
  if (/Should I generate this itinerary for you now/i.test(text)) return true;
  // Blueprint is missing the mandatory closing question — re-render so
  // the user always sees the generation confirmation prompt.
  if (!/Ready for me to generate the full itinerary\??/i.test(text)) return true;
  // Blueprint still contains an internal-only Anchor place line — re-render
  // so the user-facing summary stays clean.
  if (/(?:^|\n)\s*-?\s*\*?\*?Anchor place:\*?\*?/i.test(text)) return true;
  // Blueprint still contains a default Breakfast line even though the user
  // never requested breakfast — re-render to drop it.
  if (/(?:^|\n)\s*-?\s*\*?\*?Breakfast:\*?\*?\s*not included unless requested/i.test(text)) return true;
  // Blueprint still has a raw "visit X" pending edit — re-render so the
  // request label gets normalized.
  if (/Special requests:[^*\n]*\bvisit\s+[A-Za-z]/i.test(text)) return true;
  // Blueprint still has bare/lowercase pending edits that look unprocessed.
  if (/Special requests:[^*\n]*\bvisit churches and famous foods\b/i.test(text)) return true;
  // Blueprint still shows the raw ISO date instead of a readable range/label.
  if (/(?:^|\n)\s*-?\s*\*?\*?Dates:\*?\*?\s*\d{4}-\d{1,2}-\d{1,2}\s*$/im.test(text)) return true;
  // Blueprint shows an incomplete date value missing a day-of-month — e.g.
  // "Dates: may 2027" or "Dates: 2027" after the user corrected only the
  // year. The canonical builder will rebuild the proper "Month D–D, YYYY"
  // range from tripContext.date + tripContext.days.
  const datesValue = text.match(/(?:^|\n)\s*-?\s*\*?\*?Dates:\*?\*?\s*([^\n]+)$/im);
  if (datesValue) {
    const v = String(datesValue[1] || "").trim();
    // Strip emphasis/markdown wrappers.
    const stripped = v.replace(/^\*\*|\*\*$/g, "").trim();
    // Acceptable shapes: "Month D–D, YYYY" / "Month D, YYYY" / "Month D" /
    // "Month D – Month D, YYYY" / ISO range. Anything that contains a year
    // but no day-of-month digit alongside the month name is malformed.
    const monthNameOnly = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*,?\s*20\d{2}\s*$/i;
    const yearOnly = /^20\d{2}\s*$/;
    if (monthNameOnly.test(stripped) || yearOnly.test(stripped)) return true;
  }
  // Blueprint has a malformed destination capture or an unnormalized Camiguin typo.
  if (/(?:^|\n)\s*-?\s*\*?\*?Destination:\*?\*?\s*(?:Stay|Me A|Caniguin|Camuguin)\b/i.test(text)) return true;
  // Blueprint still shows the bland "This keeps the main stops, food
  // options, and transfer/travel timing easier to manage for the trip."
  // even though we have a destination-specific reason available.
  if (/This keeps the main stops, food options, and (?:transfer|travel) timing easier to manage for the trip\./i.test(text)) return true;
  // Special requests still contains a wholesale copied user sentence
  // (e.g. "plan me a 3 day bohol trip i want to ...").
  if (/Special requests:[^\n]*\b(?:plan me|i want|i'?d like|can you|please plan|please make)\b/i.test(text)) return true;
  return false;
}

// Detect when the LLM keeps inserting "Religious places focus" inside the
// Style line for a casual mention of churches. Force a re-render so the
// canonical builder uses Churches/heritage instead.
function blueprintHasUnjustifiedReligiousFocus(reply = "", recent = []) {
  const text = String(reply || "");
  const styleLine = text.match(/(?:^|\n)\s*-?\s*\*?\*?Style:\*?\*?\s*([^\n]+)/i);
  if (!styleLine) return false;
  const styleText = String(styleLine[1] || "").toLowerCase();
  if (!/religious places focus/.test(styleText)) return false;
  const userText = (recent || [])
    .filter((m) => m && m.role === "user")
    .map((m) => String(m.content || "").toLowerCase())
    .join(" ");
  // Only justified when the user explicitly said religious trip/focus.
  return !/\b(religious\s+(?:trip|focus|tour|places)|pilgrim|faith\s+trip|religious-only|all\s+religious)\b/.test(userText);
}

// Detect when the clarifier reply uses the cold scripted opener instead of
// a destination-aware acknowledgment. Used downstream to rewrite that turn.
function clarifierReplyHasScriptedOpener(reply = "") {
  const text = String(reply || "");
  return /\bI can build (?:this|the plan)[^.\n]*?,?\s*but I (?:still )?need\b/i.test(text) ||
    /\bPlease provide the following details\b/i.test(text);
}

// Detect the vague "Where in <X> are you going?" question even when the
// destination is already known. Triggers a rewrite so we substitute the
// specific sub-area question instead.
function clarifierReplyHasVagueDestinationQuestion(reply = "", tripContext = {}) {
  const text = String(reply || "");
  if (!/\bDestination(?:\s+or\s+area)?:\*?\*?\s+Where\s+(?:in|are)\s+/i.test(text)) return false;
  const dest = String(tripContext?.subArea || tripContext?.destination || tripContext?.country || "").trim();
  return Boolean(dest);
}

// Detect default transport-mode question. We never ask for transport by default.
function clarifierReplyAsksTransportMode(reply = "") {
  const text = String(reply || "");
  // Catch any bullet that asks about transport mode, regardless of the
  // phrasing the LLM uses ("Transport mode: ferry, flight, or land transfer?"
  // / "Transport mode: How do you want to get there — ferry, flight, or
  // land transfer?" / "Transport mode: Bus, private car, van, flight, or
  // something else?").
  if (/-?\s*\*?\*?Transport(?:\s+mode)?:\*?\*?[^\n]*(?:ferr(?:y|ies)|flight|land\s+transfer|overland|private\s+car|bus,)/i.test(text)) {
    return true;
  }
  if (/-?\s*\*?\*?Transport(?:\s+mode)?:\*?\*?[^\n]*how do you (?:want|plan) to (?:get|travel)/i.test(text)) {
    return true;
  }
  return false;
}

// When the LLM keeps emitting "Style: General travel" even though the user
// clearly gave a theme, force a rerender so inferStyleLabel can upgrade it.
function blueprintHasStaleGeneralTravelStyle(reply = "", tripContext = {}) {
  if (!/(?:^|\n)\s*-?\s*\*?\*?Style:\*?\*?\s*General travel\s*$/im.test(String(reply || ""))) return false;
  const inferred = inferStyleLabel(tripContext, []);
  if (!inferred) return false;
  return inferred && !/^general travel$/i.test(inferred);
}

// Detect when the rendered Style label conflicts with the Travelers field
// (e.g. "Family-friendly..." while Travelers: couple). Force a rerender so
// the canonical builder uses inferStyleLabel with the correct prefix.
function blueprintHasMismatchedStyleForTravelers(reply = "", tripContext = {}) {
  const text = String(reply || "");
  const travelers = String(tripContext?.travelers || "").toLowerCase();
  if (!travelers) return false;
  const styleLine = text.match(/(?:^|\n)\s*-?\s*\*?\*?Style:\*?\*?\s*([^\n]+)/i);
  if (!styleLine) return false;
  const styleText = String(styleLine[1] || "").toLowerCase();
  if (/\bcouple|partner|honeymoon\b/.test(travelers) && /\bfamily[-\s]?friendly\b/.test(styleText)) return true;
  if (/\bsolo\b/.test(travelers) && /\b(family|couple)[-\s]?friendly\b/.test(styleText)) return true;
  if (/\bfriends\b/.test(travelers) && /\b(family|couple)[-\s]?friendly\b/.test(styleText)) return true;
  if (/\b(family|parents|kids|children)\b/.test(travelers) && /\b(couple|solo|friends)[-\s]?(friendly|trip)\b/.test(styleText)) return true;
  return false;
}

// Detect when the destination shown in the blueprint disagrees with the
// originally-locked destination from the conversation (e.g. blueprint says
// "Destination: Cebu" but the conversation started with "plan me a 3 day
// bohol trip"). Force a rerender so the destination lock can restore Bohol.
async function blueprintDestinationViolatesLock(reply = "", recent = []) {
  const lock = await extractLockedDestinationFromHistory(recent);
  if (!lock) return false;
  const text = String(reply || "");
  const destLine = text.match(/(?:^|\n)\s*-?\s*\*?\*?Destination:\*?\*?\s*([^\n]+)/i);
  if (!destLine) return false;
  const destKey = normalizeIntakePlace(String(destLine[1] || ""));
  return Boolean(destKey) && !destinationLockMatchesKey(destKey, lock);
}

function formatIntakeDestination(tripContext = {}) {
  if (/\bel nido\b/i.test(String(tripContext.subArea || tripContext.destination || ""))) {
    return "El Nido, Palawan, Philippines";
  }

  const destinationValue = String(tripContext.destination || "").trim();
  const subAreaValue = String(tripContext.subArea || "").trim();
  const shouldKeepBantayanSubArea =
    /\bbantayan\b/i.test(destinationValue) &&
    /\bsanta\s+fe\b|\bsta\s+fe\b/i.test(subAreaValue);
  if (destinationValue && subAreaValue && isBaseAreaForCanonicalDestination(subAreaValue, destinationValue) && !shouldKeepBantayanSubArea) {
    const country = String(tripContext.country || "").trim();
    return [destinationValue, country].filter(Boolean).join(", ");
  }

  const parts = [];
  for (const raw of [tripContext.subArea, tripContext.destination, tripContext.country]) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const key = normalizeIntakePlace(value);
    if (!key) continue;
    if (parts.some((part) => normalizeIntakePlace(part) === key)) continue;
    parts.push(value);
  }
  return parts.join(", ");
}

function isUnsafeVisibleSummaryValue(value = "") {
  return /\b(?:placeholder|provider[-\s]?resolved|unknown|tbd|to\s+confirm)\b/i.test(String(value || ""));
}

function cleanVisibleSummaryValue(value = "") {
  const raw = String(value || "").trim();
  return raw && !isUnsafeVisibleSummaryValue(raw) ? raw : "";
}

function buildCanonicalIntakeBlueprintReply(parsed = {}, recent = []) {
  const tripContext = parsed.tripContext || {};
  tripContext.essentialsComplete = recomputeTripEssentialsComplete(tripContext);
  if (!tripContext.essentialsComplete) {
    return buildGroupedMissingFieldsQuestion(tripContext);
  }
  const dayCount = Number(tripContext.days || 0);
  const destination = cleanVisibleSummaryValue(formatIntakeDestination(tripContext));
  const origin = cleanVisibleSummaryValue(tripContext.origin);
  const dateText = String(tripContext.dates || tripContext.date || "").trim();
  const duration = String(
    tripContext.duration ||
    (dayCount ? `${dayCount} day${dayCount === 1 ? "" : "s"}` : "")
  ).trim();
  const travelers = cleanVisibleSummaryValue(tripContext.travelers);
  const style = cleanVisibleSummaryValue(tripContext.style || tripContext.theme || "General travel");
  const start = cleanVisibleSummaryValue(tripContext.itineraryStartTime || tripContext.startTime || tripContext.departureTime);
  const preTripTravel = cleanVisibleSummaryValue(tripContext.preTripTravel);
  const overnightBase = cleanVisibleSummaryValue(tripContext.overnightBase);
  const itineraryStartPoint = cleanVisibleSummaryValue(tripContext.itineraryStartPoint);
  const budget = formatIntakeBudgetLabel(tripContext.budget);
  const hotelArea = cleanVisibleSummaryValue(tripContext.hotelArea || tripContext.baseArea);
  const localTrip = isLocalIntakeTrip(tripContext);
  const transport = cleanVisibleSummaryValue(localTrip && !String(tripContext.transportMode || "").trim()
    ? "Local transport only"
    : tripContext.transportMode);
  const specialRequests = Array.isArray(tripContext.specialRequests) ? tripContext.specialRequests.filter(Boolean) : [];
  const pendingEdits = Array.isArray(parsed.pendingEdits) ? parsed.pendingEdits.filter(Boolean) : [];
  const sanitizedEdits = [...specialRequests, ...pendingEdits]
    .map((entry) => {
      const value = String(entry || "").trim();
      if (!value) return "";
      return normalizeSpecialRequestText(value) || value;
    })
    .filter(Boolean);
  const rawRequests = normalizeSpecialRequestList(sanitizedEdits);
  const requests = dropStyleFromIntakeRequests(rawRequests, style)
    .filter((request) => !isUnsafeVisibleSummaryValue(request));
  const breakfastMentioned = Boolean(tripContext.breakfastIncluded);
  const dateRange = formatIntakeDateRange(dateText, dayCount);

  const lines = [
    "**Trip summary:**",
    "",
  ];

  if (destination) lines.push(`- **Destination:** ${destination}`);
  if (origin) lines.push(`- **Origin:** ${origin}`);
  if (dateRange) lines.push(`- **Dates:** ${dateRange}`);
  if (duration) lines.push(`- **Duration:** ${duration}`);
  if (travelers) lines.push(`- **Travelers:** ${travelers}`);
  lines.push(`- **Style:** ${style || "General travel"}`);
  if (preTripTravel) lines.push(`- **Pre-trip travel:** ${preTripTravel}`);
  if (overnightBase) lines.push(`- **Overnight:** ${overnightBase}`);
  if (itineraryStartPoint) lines.push(`- **Itinerary start point:** ${itineraryStartPoint}`);
  if (start) lines.push(`- **Start:** ${start}`);
  if (budget) lines.push(`- **Budget:** ${budget}`);
  if (localTrip && !hotelArea) {
    lines.push(`- **Accommodation:** Not needed / local trip`);
  } else if (hotelArea) {
    lines.push(`- **Hotel/base:** ${hotelArea}`);
  }
  if (transport) {
    lines.push(`- **Transport:** ${transport}`);
  }
  if (breakfastMentioned) {
    lines.push(`- **Meals:** ${String(tripContext.breakfastNote || "Breakfast included").trim()}`);
  }
  if (requests.length) lines.push(`- **Special requests:** ${requests.join(", ")}`);

  if (hotelArea && !localTrip) {
    const baseReason = cleanVisibleSummaryValue(buildRecommendedBaseReason(hotelArea, destination, tripContext, requests));
    lines.push("", `**Recommended base:** ${hotelArea}`);
    if (baseReason) lines.push("", baseReason);
  }

  lines.push("", buildGenerateItineraryQuestion(`${destination}|${dateRange}|${travelers}|${requests.join(",")}`));
  return lines.join("\n");
}

function replyHasAccommodationSuggestionList(reply = "") {
  const text = String(reply || "");
  if (!text) return false;
  // Heading-style signals
  if (/\b(?:stays likely under|stays\/base areas likely|stays to check|stay\/base recommendation|Accommodation fallback|Budget hotel suggestions|hotel suggestions|hotels near|stay options|stays?\s+(?:in|near|around)\b|places?\s+to\s+stay\b|where\s+to\s+stay\b|under\s+(?:PHP|₱|\$|HKD|JPY|THB|MYR|SGD)\b)\b/i.test(text)) {
    return true;
  }
  // Bullet-list heuristic: at least two bulleted entries that look like named
  // hotel/hostel/inn/resort options. Catches LLM lists that don't include
  // any of the heading phrases above.
  const bulletNames = text.match(/(?:^|\n)\s*[-•]\s+\*\*([^*\n]{2,80})\*\*/g) || [];
  if (bulletNames.length >= 2) {
    let stayLikeCount = 0;
    for (const b of bulletNames) {
      if (/\b(hotel|hostel|guesthouse|inn|resort|lodge|cottages?|villa|apartments?|bnb|bed\s+and\s+breakfast|pension|hostal|ryokan|hostal)\b/i.test(b)) {
        stayLikeCount += 1;
      }
    }
    if (stayLikeCount >= 2) return true;
  }
  return false;
}

function replyAsksBudgetQuestion(reply = "") {
  return /-\s+\*\*Budget:\*\*|\bBudget,\s*mid\s*-?\s*range,\s*or\s*luxury\?/i.test(String(reply || ""));
}

function normalizeIntakeQuestionLabel(label = "") {
  const key = String(label || "")
    .toLowerCase()
    .replace(/\*\*/g, "")
    .replace(/[^a-z/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!key) return "";
  if (/sub\s*area|base area|base choice|hotel\/base|hotel base|^base$/.test(key)) return "base";
  if (/travel dates|dates and length|date\/month|^dates?$/.test(key)) return "date";
  if (/traveler|traveller/.test(key)) return "travelers";
  if (/budget/.test(key)) return "budget";
  if (/origin|starting/.test(key)) return "origin";
  if (/start/.test(key)) return "start_time";
  if (/duration|trip length/.test(key)) return "duration";
  if (/destination|area/.test(key)) return "destination";
  return key;
}

function extractIntakeQuestionLabels(reply = "") {
  const labels = [];
  const lines = String(reply || "").split(/\r?\n/);
  for (const line of lines) {
    const match = String(line || "").match(/^\s*(?:[-*•]\s*)?(?:\*\*)?([A-Za-z][A-Za-z /-]{2,40}?)(?:\*\*)?\s*:\s+\S/);
    if (!match) continue;
    const label = normalizeIntakeQuestionLabel(match[1]);
    if (label) labels.push(label);
  }
  return labels;
}

function replyHasDuplicateIntakeQuestionBlocks(reply = "") {
  const labels = extractIntakeQuestionLabels(reply);
  if (labels.length < 4) return false;
  const seen = new Set();
  for (const label of labels) {
    if (seen.has(label)) return true;
    seen.add(label);
  }
  return false;
}

function replyContainsMissingInfoQuestion(reply = "") {
  return /\b(?:I can build this, but I (?:still )?need|I still need|need a few (?:details|essentials)|one key detail before I can show the trip summary)\b/i.test(
    String(reply || "")
  );
}

function stripBlueprintSection(reply = "") {
  const text = String(reply || "").trim();
  const marker = text.search(/\*\*?\s*Trip summary:?\s*\*\*?/i);
  if (marker < 0) return text;
  return text
    .slice(0, marker)
    .replace(/\s*---\s*$/i, "")
    .trim();
}

function stripMissingInfoQuestionSection(reply = "") {
  const text = String(reply || "").trim();
  const marker = text.search(/\b(?:I can build this, but I (?:still )?need|I still need|need a few (?:details|essentials)|one key detail before I can show the trip summary)\b/i);
  if (marker < 0) return text;
  return text
    .slice(0, marker)
    .replace(/\s*---\s*$/i, "")
    .trim();
}

function needsMissingBudgetRepair(parsed = {}, reply = "") {
  const tripContext = parsed.tripContext || {};
  if (tripContext.budget) return false;
  if (looksLikeBlueprintReply(reply) || parsed.intent === "show_blueprint" || tripContext.essentialsComplete) {
    return true;
  }
  return replyIsSetupOnlyQuestion(reply) && !replyAsksBudgetQuestion(reply);
}

// Sanitize the LLM's literal reply text before it ships:
//   - Strip "None, " from "Special requests:" lines (the LLM sometimes
//     keeps "None" from a previous turn and prepends real entries).
//   - Collapse two back-to-back accommodation suggestion blocks (the
//     intake recommendation injector + the LLM's own list can both fire
//     when the user explicitly asks for hotels under a cap).
function sanitizeIntakeBlueprintReplyText(replyText = "") {
  let out = String(replyText || "");
  if (!out) return out;
  out = out
    .replace(/\bI still need one key detail before I can show the trip summary:?\b/gi, "A few details will help me shape the route:")
    .replace(/\bI just need one more detail(?: before I can show the trip summary)?:?\b/gi, "One detail will finish the trip summary:");
  out = out.replace(
    /(\*?\*?Special\s+requests:?\*?\*?\s*)None\s*[,;]\s*/gi,
    "$1"
  );
  out = out.replace(
    /(\*?\*?Special\s+requests:?\*?\*?\s*)None\s*$/gim,
    "$1None"
  );
  // De-duplicate consecutive identical accommodation suggestion blocks
  // (same heading + same first bullet). Keep the first, drop the second.
  const blockHeadingRx = /\*\*[^*\n]+stays?(?:\s*\/\s*base\s+areas?)?\b[^*\n]*\*\*/gi;
  const seenBlocks = new Set();
  out = out.replace(
    /(\*\*[^*\n]+stays?(?:\s*\/\s*base\s+areas?)?\b[^*\n]*\*\*\n(?:[ \t]*-\s*\*\*[^\n]+\n){1,6}(?:[\s\S]*?))(?=\n\s*\*\*[^*\n]+stays?(?:\s*\/\s*base\s+areas?)?\b|\n\s*Trip summary|\n\s*Should I generate|$)/gi,
    (block) => {
      const headingMatch = block.match(blockHeadingRx)?.[0] || "";
      const firstBullet = (block.match(/-\s*\*\*[^\n]+/g) || [])[0] || "";
      const key = `${headingMatch}|${firstBullet}`.toLowerCase();
      if (seenBlocks.has(key)) return "";
      seenBlocks.add(key);
      return block;
    }
  );

  // Strip acknowledgement-only sections left behind by older section joins.
  const ORPHAN_ACK_RX = /^(?:Got it|Nice pick|Solid choice|Easy|Sounds fun)\s*[—-]\s+[^.\n]+\.\s*$/i;
  const cleanedSections = String(out || "")
    .split(/\n{2,}---\n{2,}/)
    .map((s) => s.trim())
    .filter((s, idx, arr) => {
      if (!s) return false;
      if (!ORPHAN_ACK_RX.test(s)) return true;
      return arr.length === 1;
    });
  out = cleanedSections.join("\n\n---\n\n");
  return out;
}

async function enforceIntakeRecommendationSections(parsed = {}, recent = [], appContext = {}) {
  if (!parsed || typeof parsed !== "object") return parsed;
  const latestUser = getLatestUserText(recent);
  const normalizedParsed = await normalizeTripContextForLatestUser(parsed, recent);
  const sections = [];
  const originalReply = String(normalizedParsed.replyText || "").trim();
  const tripContext = normalizedParsed.tripContext || {};
  await prepareTripContextForEssentials(tripContext, appContext);
  const destinationLabel = String(tripContext.subArea || tripContext.destination || "").trim();
  if (latestUserSaysResponseIsConfusing(latestUser)) {
    const destinationKey = normalizeIntakePlace(formatIntakeDestination(tripContext) || getIntakeDestinationLabel(tripContext));
    if (/\bcamiguin\b/.test(destinationKey)) {
      if (!tripContext.baseArea) tripContext.baseArea = "Mambajao / Yumbing";
      const next = nextMissingFinalQuestion(tripContext);
      return {
        ...normalizedParsed,
        intent: "update_context",
        shouldGenerate: false,
        tripContext,
        replyText: [
          "You’re right — let me simplify.",
          "",
          "**Destination:** Camiguin, Philippines",
          "**Recommended base:** Mambajao / Yumbing",
          "This is the most practical first-time base for food, White Island access, transport rentals, waterfalls, hot springs, and common tour routes.",
          ...(next ? ["", `**Next detail:** ${next[1]}`] : ["", buildGenerateItineraryQuestion(destinationKey || "camiguin")]),
        ].join("\n"),
      };
    }
  }
  // Stage 1: blueprint card rewrites.
  let reply = (
    shouldReplaceMalformedBlueprintReply(originalReply) ||
    blueprintHasStaleGeneralTravelStyle(originalReply, tripContext) ||
    blueprintHasMismatchedStyleForTravelers(originalReply, tripContext) ||
    (await blueprintDestinationViolatesLock(originalReply, recent)) ||
    blueprintHasUnjustifiedReligiousFocus(originalReply, recent)
  )
    ? buildCanonicalIntakeBlueprintReply(normalizedParsed, recent)
    : originalReply;
  const staleAccommodationReply =
    latestUserRequestsAccommodationRecommendations(latestUser) &&
    accommodationReplyDestinationMismatch(reply, tripContext);
  if (staleAccommodationReply) {
    reply = stripBlueprintSection(reply);
    if (replyHasAccommodationSuggestionList(reply)) reply = "";
  }

  // Stage 2: when this turn is a clarifier (not a blueprint), replace any
  // scripted opener / vague destination question / default transport-mode
  // question with the canonical destination-aware clarifier from
  // buildGroupedMissingFieldsQuestion. We keep any leading non-question
  // section (e.g. a Highlights block) before the clarifier so the warm
  // context survives.
  if (
    !looksLikeBlueprintReply(reply) &&
    (clarifierReplyHasScriptedOpener(reply) ||
      clarifierReplyHasVagueDestinationQuestion(reply, tripContext) ||
      clarifierReplyAsksTransportMode(reply))
  ) {
    const canonicalClarifier = buildGroupedMissingFieldsQuestion(tripContext);
    if (canonicalClarifier) {
      // Replace the whole reply with the canonical clarifier. Do NOT keep
      // a "lead" section and join with --- — that stacks the LLM's natural
      // prose on top of the deterministic template and produces the
      // duplicated 2-block intake (Bantayan natural prose + "Nice pick —
      // Bantayan, Philippines can work well here" template).
      reply = canonicalClarifier;
    }
  }

  if (previousAssistantAskedInheritanceConfirmation(recent) && latestUserExplicitlyRejectsInheritance(latestUser)) {
    return {
      ...normalizedParsed,
      intent: "update_context",
      shouldGenerate: false,
      replyText: buildTripSwitchFreshDetailsQuestion(tripContext),
    };
  }

  if (
    previousAssistantAskedInheritanceConfirmation(recent) &&
    latestUserExplicitlyAcceptsInheritance(latestUser) &&
    !latestUserProvidesBaseSetting(latestUser)
  ) {
    return {
      ...normalizedParsed,
      intent: "update_context",
      shouldGenerate: false,
      replyText: buildTripSwitchBaseQuestion(tripContext),
    };
  }

  const switchConfirmationPrevious = needsTripSwitchInheritanceConfirmation(normalizedParsed, recent, reply);
  if (switchConfirmationPrevious) {
    return {
      ...normalizedParsed,
      intent: "update_context",
      shouldGenerate: false,
      replyText: buildTripSwitchInheritanceConfirmation({
        latestUser,
        tripContext,
        previous: switchConfirmationPrevious,
      }),
    };
  }

  if (needsDestinationFirstClarifier(normalizedParsed, reply)) {
    return {
      ...normalizedParsed,
      intent: "update_context",
      shouldGenerate: false,
      replyText: buildDestinationFirstClarifier(tripContext),
    };
  }

  if (!tripContext.essentialsComplete && looksLikeBlueprintReply(reply)) {
    return {
      ...normalizedParsed,
      intent: "update_context",
      shouldGenerate: false,
      tripContext,
      replyText: buildGroupedMissingFieldsQuestion(tripContext),
    };
  }

  const resetOrCorrection =
    latestUserRequestsTripReset(latestUser) || latestUserLooksLikeTripCorrection(latestUser);
  if (resetOrCorrection && tripContext.essentialsComplete) {
    return {
      ...normalizedParsed,
      intent: "show_blueprint",
      shouldGenerate: false,
      pendingEdits: [],
      replyText: buildCanonicalIntakeBlueprintReply(
        { ...normalizedParsed, pendingEdits: [] },
        recent
      ),
    };
  }

  if (
    latestUserDemandsDraftNow(latestUser) &&
    Number(tripContext.days || 0) > 0 &&
    destinationLabel &&
    replyIsSetupOnlyQuestion(reply)
  ) {
    const draftReply = buildDraftItineraryReply(tripContext, latestUser);
    if (draftReply) {
      return {
        ...normalizedParsed,
        replyText: draftReply,
      };
    }
  }

  if (
    latestUserIntroducesSpecificDestination(latestUser, tripContext) &&
    destinationLabel &&
    !recentAssistantAlreadyShowedHighlights(recent, destinationLabel) &&
    !/Highlights include:/i.test(reply)
  ) {
    const highlightSection = buildSpecificDestinationHighlightsSection(tripContext);
    if (highlightSection) sections.push(highlightSection);
  }

  if (latestUserRequestsAccommodationRecommendations(latestUser)) {
    // Single source of truth for stay recommendations. The deterministic
    // builder owns the visible list — the LLM's free-form reply is dropped
    // entirely so we never end up with two stay lists in one response.
    // We still keep upstream "sections" that aren't stay lists themselves
    // (e.g. destination highlights), and append the blueprint if essentials
    // were just completed.
    const deterministicAccommodation = buildAccommodationRecommendationSection(tripContext, latestUser);
    const safeUpstreamSections = sections.filter(
      (section) => !replyHasAccommodationSuggestionList(section)
    );
    const repairedSections = [
      ...safeUpstreamSections,
      deterministicAccommodation,
    ];
    let finalSections = appendBlueprintIfSetupCompletedAfterRecommendation({
      normalizedParsed,
      recent,
      latestUser,
      sections: repairedSections,
    });
    const hasBlueprint = finalSections.some((section) => looksLikeBlueprintReply(section));
    if (!hasBlueprint && finalSections.length) {
      finalSections = [...finalSections];
      finalSections[finalSections.length - 1] = appendRecommendationNextStep(
        finalSections[finalSections.length - 1],
        tripContext
      );
    }
    return {
      ...normalizedParsed,
      intent: hasBlueprint ? "show_blueprint" : "answer_question",
      shouldGenerate: false,
      pendingEdits: [],
      replyText: finalSections.filter(Boolean).join("\n\n---\n\n"),
    };
  }

  if (latestUserRequestsDirectAnswerOnly(latestUser) && looksLikeBlueprintReply(reply)) {
    const preservedAnswer = stripMissingInfoQuestionSection(stripBlueprintSection(reply));
    const directSections = [...sections, preservedAnswer].filter(Boolean);
    if (directSections.length) {
      return {
        ...normalizedParsed,
        intent: "answer_question",
        shouldGenerate: false,
        pendingEdits: [],
        replyText: sanitizeIntakeBlueprintReplyText(directSections.join("\n\n---\n\n")),
      };
    }
  }

  if (tripContext.essentialsComplete && replyContainsMissingInfoQuestion(reply)) {
    const preservedAnswer = stripMissingInfoQuestionSection(reply);
    const repairedSections = [...sections];
    if (preservedAnswer && !looksLikeBlueprintReply(preservedAnswer)) {
      repairedSections.push(preservedAnswer);
    }
    repairedSections.push(buildCanonicalIntakeBlueprintReply(normalizedParsed, recent));
    return {
      ...normalizedParsed,
      intent: "show_blueprint",
      shouldGenerate: false,
      replyText: repairedSections.filter(Boolean).join("\n\n---\n\n"),
    };
  }

  const missingFieldsQuestion = buildGroupedMissingFieldsQuestion(tripContext);
  if (resetOrCorrection && missingFieldsQuestion) {
    return {
      ...normalizedParsed,
      intent: "update_context",
      shouldGenerate: false,
      pendingEdits: [],
      tripContext: {
        ...tripContext,
        essentialsComplete: false,
      },
      replyText: [...sections, missingFieldsQuestion].filter(Boolean).join("\n\n---\n\n"),
    };
  }

  if (missingFieldsQuestion && needsMissingBudgetRepair(normalizedParsed, reply)) {
    const preservedAnswer = stripBlueprintSection(reply);
    const repairedSections = [...sections];
    if (
      preservedAnswer &&
      !looksLikeBlueprintReply(preservedAnswer) &&
      (!replyIsSetupOnlyQuestion(preservedAnswer) ||
        replyHasAccommodationSuggestionList(preservedAnswer) ||
        /Highlights include:/i.test(preservedAnswer))
    ) {
      repairedSections.push(preservedAnswer);
    }
    return {
      ...normalizedParsed,
      intent: "update_context",
      shouldGenerate: false,
      tripContext: {
        ...tripContext,
        budget: null,
        essentialsComplete: false,
      },
      replyText: [...repairedSections, missingFieldsQuestion].filter(Boolean).join("\n\n---\n\n"),
    };
  }

  if (!sections.length && reply === originalReply) {
    const sanitized = sanitizeIntakeBlueprintReplyText(normalizedParsed.replyText || "");
    if (sanitized !== normalizedParsed.replyText) {
      return { ...normalizedParsed, replyText: sanitized };
    }
    return normalizedParsed;
  }
  return {
    ...normalizedParsed,
    replyText: sanitizeIntakeBlueprintReplyText(
      [...sections, reply].filter(Boolean).join("\n\n---\n\n")
    ),
  };
}

function enforceBundledIntakeQuestionDecision(decision = {}, recent = []) {
  if (!decision || typeof decision !== "object") return decision;
  if (decision.shouldGenerate || decision.intent === "show_blueprint") return decision;

  const tripContext = decision.tripContext || {};
  const reply = String(decision.replyText || "");
  if (!reply.trim() && recomputeTripEssentialsComplete(tripContext)) {
    tripContext.essentialsComplete = true;
    return {
      ...decision,
      intent: "show_blueprint",
      shouldGenerate: false,
      pendingEdits: [],
      tripContext,
      replyText: buildCanonicalIntakeBlueprintReply({ ...decision, tripContext, pendingEdits: [] }, recent),
    };
  }
  const canonicalQuestion = buildGroupedMissingFieldsQuestion(tripContext);
  if (!canonicalQuestion) {
    return {
      ...decision,
      replyText: sanitizeIntakeBlueprintReplyText(decision.replyText || ""),
    };
  }

  if (!reply.trim()) return { ...decision, replyText: canonicalQuestion };

  const questionLineRx =
    /^\s*[-*]\s+\*\*(?:Destination(?:\s+or\s+area)?|Sub-?area|Area|Origin|Travelers?|Travellers?|Budget|Start(?:\s+time)?|Hotel\/base|Base|Duration|Trip\s+length|Travel\s+dates|Dates(?:\s+and\s+length)?|Date(?:\/month)?)\s*:\*\*/i;
  const questionLines = reply.split(/\r?\n/).filter((line) => questionLineRx.test(line));
  const hasMultiQuestion = questionLines.length > 1;
  const looksLikeIntakeQuestion =
    replyContainsMissingInfoQuestion(reply) ||
      replyIsSetupOnlyQuestion(reply) ||
      hasMultiQuestion;

  const hasTooManyQuestions = questionLines.length > 5;
  const hasBannedPhrase =
    /\bI still need one key detail\b|\bI just need one more detail(?: before I can show the trip summary)?\b/i.test(reply);
  const hasDuplicateIntakeBlocks = replyHasDuplicateIntakeQuestionBlocks(reply);
  const hasBantayanMainlandOption =
    isBantayanIntakeTrip(tripContext) &&
    /\bSan\s+Remigio\b/i.test(reply);

  if (!looksLikeIntakeQuestion || (!hasTooManyQuestions && !hasBannedPhrase && !hasDuplicateIntakeBlocks && !hasBantayanMainlandOption)) {
    return {
      ...decision,
      replyText: sanitizeIntakeBlueprintReplyText(reply),
    };
  }

  return {
    ...decision,
    replyText: sanitizeIntakeBlueprintReplyText(canonicalQuestion),
  };
}

async function buildGeneratedAccommodationRecommendationSection(client, { tripContext = {}, latestUser = "", appContext = {} } = {}) {
  const fallback = buildAccommodationRecommendationSection(tripContext, latestUser);
  const destination = safeAccommodationDestinationLabel(getIntakeDestinationLabel(tripContext), tripContext);
  const base = String(tripContext?.baseArea || tripContext?.hotelArea || tripContext?.subArea || "").trim();

  const providerBacked = await buildProviderBackedAccommodationRecommendationSection({
    tripContext,
    latestUser,
    appContext,
  });
  if (providerBacked) return providerBacked;
  if (!client?.chat?.completions?.create) return fallback;

  const budgetPhrase =
    formatNightlyBudgetPhraseFromUserText(latestUser) ||
    String(tripContext?.accommodationBudget || "").trim() ||
    formatNightlyCapFromUserText(latestUser);
  const model = String(
    process.env.AI_MODEL || settingsFor().model
  ).trim();

  try {
    const completion = await client.chat.completions.create({
      model,
      max_completion_tokens: 1800,
      temperature: 0.35,
      messages: [
        {
          role: "system",
          content:
            "You are TravelMate's accommodation recommendation helper. Generate a traveler-specific stay/base recommendation from the provided trip facts and latest request. " +
            "Do not use a canned static list. Do not claim to book rooms. If you mention named properties, present them as options to verify, because live rates and availability change. " +
            "Do not invent live prices, room availability, booking guarantees, or payment/reservation steps. " +
            "Return only the accommodation section, not the trip summary. Use concise markdown bullets. " +
            "Each option MUST be its own bullet line starting with '- **<area name>:**' followed by the description on the same line or a wrapped continuation. Never run multiple bolded labels into a single paragraph. " +
            "Finish ALL options you start — do not leave a list mid-way. If the response would be very long, prefer fewer options with full content over many options truncated."
        },
        {
          role: "user",
          content: JSON.stringify({
            destination,
            baseArea: base,
            budgetOrNightlyCap: budgetPhrase || "",
            travelers: tripContext.travelers || "",
            tripBudget: tripContext.budget || "",
            dates: tripContext.date || tripContext.dates || "",
            origin: tripContext.origin || "",
            startTime: tripContext.startTime || "",
            latestRequest: latestUser,
            timezone: String(appContext?.timezone || "").trim() || "UTC",
            requiredShape: [
              `Heading naming ${destination}`,
              "3-5 request-specific stay/base options or search filters",
              base ? `State that ${base} is the working base unless the traveler chooses a specific hotel` : "Recommend the most practical base area",
              "End with: I can't verify live rates or availability. Check Agoda, Booking.com, Traveloka, or map search before deciding. TravelMate does not book rooms."
            ]
          })
        }
      ]
    });
    const reply = String(completion?.choices?.[0]?.message?.content || "").trim();
    if (!reply) return fallback;
    if (accommodationReplyDestinationMismatch(reply, tripContext)) return fallback;
    if (/\b(?:trip summary|should i generate the full itinerary now)\b/i.test(reply)) return fallback;
    return enforceBulletedAccommodationRecommendationText(reply);
  } catch (error) {
    console.warn("[intake] generated accommodation section failed", { err: String(error?.message || error || "") });
    return fallback;
  }
}
// Detect the index of the LATEST user message that starts a fresh trip
// request ("plan me a 3 day trip in baguio", "i want to go to bantayan",
// "switch to tokyo", etc.). Returns -1 when no such message exists.
//
// When the user begins a new trip mid-conversation, every message BEFORE
// this index belongs to a different trip and must not be used to infer
// the current trip's fields (dates, travelers, style, transport, etc.).
// Without this scope, the LLM extracts "Dates: June 19-21" from a prior
// Moalboal summary when the current Baguio reply says "july 20".
function findFreshTripStartIndex(recentMessages = []) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  let resetIndex = -1;
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (!m || m.role !== "user") continue;
    const text = String(m.content || "").toLowerCase();
    if (!text) continue;
    // Match patterns that introduce a new destination:
    //   - "plan me a 3 day trip in baguio"
    //   - "create a 5 day trip to tokyo"
    //   - "i want to go to bantayan for 3 days"
    //   - "i want to visit moalboal"
    //   - "switch to japan"
    //   - "plan a trip in <place>"
    const looksLikeNewTrip =
      /\b(?:plan|create|make|build|draft|generate)\s+(?:me\s+|us\s+)?(?:a\s+|an\s+)?(?:\d+\s*[- ]?\s*(?:day|days|night|nights)\s+)?(?:trip|itinerary|travel\s+plan|plan|tour|vacation|getaway)\s+(?:in|to|for|around|at|near)\s+[a-z]/i.test(text) ||
      /\bi\s+(?:want|wanna|would\s+like)\s+to\s+(?:go|visit|travel|head)\s+(?:to\s+)?[a-z]/i.test(text) ||
      /\b(?:switch|change|move)\s+to\s+[a-z]/i.test(text) ||
      /\b(?:now\s+)?i\s+want\s+to\s+(?:plan|go|visit|see)\s+[a-z]/i.test(text);
    if (looksLikeNewTrip) {
      resetIndex = i;
    }
  }
  return resetIndex;
}

// Scope the conversation to only messages from the most recent fresh-trip
// request onward. If no fresh-trip request exists in the buffer, return
// the original list unchanged.
function scopeRecentToActiveTrip(recentMessages = []) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const idx = findFreshTripStartIndex(list);
  return idx > 0 ? list.slice(idx) : list;
}

async function processIntakeTurn(client, { messages = [], appContext = {} } = {}) {
  if (!client) return null;

  const rawRecentFull = [...messages]
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-20)
    .map((m) => ({
      role: m.role,
      content: String(m.content || "").trim().slice(0, 2000)
    }));
  // Scope to active trip. When the user has started a new trip request
  // (e.g. "plan me a 3 day trip in baguio") earlier in this 20-message
  // window, every message before that point belongs to a different trip
  // and would leak fields (dates/travelers/style/transport) into the new
  // trip's intake. Scoping makes the new trip a clean slate.
  const rawRecent = scopeRecentToActiveTrip(rawRecentFull);
  const recent = rawRecent
    .map((m) => ({
      role: m.role,
      content: String(m.content || "").replace(/\s+/g, " ").trim().slice(0, 1200)
    }));
  if (!recent.length) return null;
  if (confirmedBlueprintFromRecent(recent)) return buildConfirmedBlueprintDecision();
  const complaintOrMetaDecision = await buildComplaintOrMetaDecision(recent);
  if (complaintOrMetaDecision) return complaintOrMetaDecision;
  const alreadyProvidedDecision = await buildAlreadyProvidedDetailsDecision(recent, appContext);
  if (alreadyProvidedDecision) return alreadyProvidedDecision;
  if (
    previousAssistantOfferedTripSummary(recent) &&
    !latestUserRequestsAccommodationRecommendations(getLatestUserText(rawRecent))
  ) {
    const normalized = await normalizeTripContextForLatestUser(
      {
        intent: "show_blueprint",
        tripContext: createBlankTripContext(),
        replyText: "",
        pendingEdits: [],
        shouldGenerate: false,
      },
      rawRecent
    );
    return buildBlueprintOrMissingDecision(normalized, rawRecent, appContext, { pendingEdits: [] });
  }
  if (latestUserRequestsTripSummary(getLatestUserText(rawRecent))) {
    const normalized = await normalizeTripContextForLatestUser(
      {
        intent: "show_blueprint",
        tripContext: createBlankTripContext(),
        replyText: "",
        pendingEdits: [],
        shouldGenerate: false,
      },
      rawRecent
    );
    return buildBlueprintOrMissingDecision(normalized, rawRecent, appContext, { pendingEdits: [] });
  }
  if (extractLatestBlueprintContext(rawRecent) && latestUserLooksLikeTripCorrection(getLatestUserText(rawRecent))) {
    const normalized = await normalizeTripContextForLatestUser(
      {
        intent: "show_blueprint",
        tripContext: createBlankTripContext(),
        replyText: "",
        pendingEdits: [],
        shouldGenerate: false,
      },
      rawRecent
    );
    return buildBlueprintOrMissingDecision(normalized, rawRecent, appContext, { pendingEdits: [] });
  }
  if (extractLatestBlueprintContext(rawRecent) && latestUserLooksLikePendingBlueprintRevision(getLatestUserText(rawRecent))) {
    const normalized = await normalizeTripContextForLatestUser(
      {
        intent: "show_blueprint",
        tripContext: createBlankTripContext(),
        replyText: "",
        pendingEdits: [],
        shouldGenerate: false,
      },
      rawRecent
    );
    return buildBlueprintOrMissingDecision(normalized, rawRecent, appContext);
  }
  if (latestUserRequestsAccommodationRecommendations(getLatestUserText(recent))) {
    const latestUser = getLatestUserText(recent);
    const normalized = await normalizeTripContextForLatestUser(
      {
        intent: "answer_question",
        tripContext: createBlankTripContext(),
        replyText: "",
        pendingEdits: [],
        shouldGenerate: false,
      },
      rawRecent
    );
    const accommodationRequestText = [latestAccommodationRequestText(rawRecent.slice(0, -1)), latestUser]
      .filter(Boolean)
      .join(" ");
    const sections = [
      await buildGeneratedAccommodationRecommendationSection(client, {
        tripContext: normalized.tripContext || {},
        latestUser: accommodationRequestText,
        appContext,
      }),
    ];
    const finalSections = appendBlueprintIfSetupCompletedAfterRecommendation({
      normalizedParsed: normalized,
      recent: rawRecent,
      latestUser,
      sections,
    });
    return {
      ...normalized,
      intent: finalSections.some((section) => looksLikeBlueprintReply(section)) ? "show_blueprint" : "answer_question",
      shouldGenerate: false,
      pendingEdits: [],
      replyText: finalSections.join("\n\n---\n\n"),
    };
  }
  const accommodationShortlistRefinement = await buildAccommodationShortlistRefinementDecision(recent);
  if (accommodationShortlistRefinement) return accommodationShortlistRefinement;
  if (previousAssistantOfferedAccommodationRecommendation(recent)) {
    const latestUser = getLatestUserText(recent);
    if (
      userAffirmsBlueprintGeneration(latestUser) &&
      !latestUserRequestsAccommodationRecommendations(latestUser)
    ) {
      const normalized = await normalizeTripContextForLatestUser(
        {
          intent: "show_blueprint",
          tripContext: createBlankTripContext(),
          replyText: "",
          pendingEdits: [],
          shouldGenerate: false,
        },
        rawRecent
      );
      await prepareTripContextForEssentials(normalized.tripContext || {}, appContext);
      if (normalized.tripContext?.essentialsComplete) {
        return buildBlueprintOrMissingDecision(normalized, rawRecent, appContext, { pendingEdits: [] });
      }
    }
    const normalized = await normalizeTripContextForLatestUser(
      {
        intent: "answer_question",
        tripContext: createBlankTripContext(),
        replyText: "",
        pendingEdits: [],
        shouldGenerate: false,
      },
      rawRecent
    );
    const sections = [
      await buildGeneratedAccommodationRecommendationSection(client, {
        tripContext: normalized.tripContext || {},
        latestUser: latestAccommodationRequestText(rawRecent),
        appContext,
      }),
    ];
    const finalSections = appendBlueprintIfSetupCompletedAfterRecommendation({
      normalizedParsed: normalized,
      recent: rawRecent,
      latestUser,
      sections,
    });
    return {
      ...normalized,
      intent: finalSections.some((section) => looksLikeBlueprintReply(section)) ? "show_blueprint" : "answer_question",
      shouldGenerate: false,
      replyText: finalSections.join("\n\n---\n\n"),
    };
  }

  const latestUser = getLatestUserText(rawRecent);
  if (looksLikeBareAccommodationSelectionForIntake(latestUser)) {
    const normalized = await normalizeTripContextForLatestUser(
      {
        intent: "show_blueprint",
        tripContext: createBlankTripContext(),
        replyText: "",
        pendingEdits: [],
        shouldGenerate: false,
      },
      rawRecent
    );
    const tripContext = normalized.tripContext || {};
    if (!tripContext.selectedHotel) {
      tripContext.selectedHotel = titleCaseIntakeValue(cleanAccommodationSelectionNameForIntake(latestUser));
    }
    if (!tripContext.baseArea) {
      const recommendedBase = accommodationRecommendationBaseFromRecent(rawRecent);
      if (recommendedBase) {
        tripContext.baseArea = canonicalKnownBaseAreaForIntake(recommendedBase) || titleCaseIntakeValue(recommendedBase);
      }
    }
    if (tripContext.selectedHotel && !tripContext.hotelArea) {
      tripContext.hotelArea = formatSelectedHotelBaseLabelForIntake(tripContext.selectedHotel, tripContext.baseArea || "");
      tripContext.noHotelYet = false;
      tripContext.hotelStatus = "selected";
    }
    return buildBlueprintOrMissingDecision({ ...normalized, tripContext }, rawRecent, appContext, { pendingEdits: [] });
  }
  if (
    latestUserProvidesSetupDetail(latestUser) &&
    !latestUserRequestsDirectAnswerOnly(latestUser) &&
    !latestUserRequestsAccommodationRecommendations(latestUser)
  ) {
    const normalized = await normalizeTripContextForLatestUser(
      {
        intent: "update_context",
        tripContext: createBlankTripContext(),
        replyText: "",
        pendingEdits: [],
        shouldGenerate: false,
      },
      rawRecent
    );
    if (normalized.tripContext?.essentialsComplete) {
      return buildBlueprintOrMissingDecision(normalized, rawRecent, appContext, { pendingEdits: [] });
    }
  }

  if (!llmFirstIntakeEnabled()) return null;

  const model = String(
    process.env.AI_MODEL || settingsFor().model
  ).trim();

  try {
    const completion = await client.chat.completions.create({
      model,
      max_completion_tokens: 2400,
      response_format: { type: "json_schema", json_schema: TRIP_CONTROLLER_SCHEMA },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            timezone: String(appContext?.timezone || "").trim() || "UTC",
            todayISO: String(appContext?.todayISO || "").trim() || "",
            recentConversation: recent
          })
        }
      ]
    });

    const refusal = completion?.choices?.[0]?.message?.refusal;
    if (refusal) return null;

    const finishReason = completion?.choices?.[0]?.finish_reason || "";
    const raw = completion?.choices?.[0]?.message?.content || "";
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (parseError) {
      console.warn("[intake.controller] JSON parse failed", {
        finishReason,
        rawLength: raw.length,
        err: String(parseError?.message || parseError),
      });
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.intent || !parsed.tripContext || typeof parsed.replyText !== "string") return null;

    const formatted = enforceBulletedTripSummaryFormat(enforceBulletedRecommendationFormat(parsed));
    return enforceBundledIntakeQuestionDecision(await enforceIntakeRecommendationSections(formatted, recent, appContext), recent);
  } catch (error) {
    console.warn("[intake.controller] failed", { err: String(error?.message || error || "") });
    return null;
  }
}

const TRIP_SUMMARY_FIELD_LABELS = [
  "Destination", "Origin", "Dates", "Duration", "Travelers", "Style",
  "Pre-trip travel", "Overnight", "Itinerary start point", "Start",
  "Budget", "Hotel/base", "Base", "Transport", "Special requests", "Meals",
  "Accommodation", "Recommended base",
];

function enforceBulletedAccommodationRecommendationText(reply = "") {
  const text = String(reply || "").trim();
  if (!text) return text;
  const boldLabels = [...text.matchAll(/\*\*([^*\n]{2,80}?)\*\*/g)];
  if (boldLabels.length < 3) return text;
  const existingBullets = (text.match(/(?:^|\n)\s*-\s+\*\*[^*\n]+:\*\*/g) || []).length;
  if (existingBullets >= 2) return text;
  const recommendationSignal =
    replyHasAccommodationSuggestionList(text) ||
    /\b(?:best|budget|stay|stays|base|hotel|hostel|accommodation|options?|recommendation)\b/i.test(text);
  if (!recommendationSignal) return text;

  let start = 0;
  const firstEnd = boldLabels[0].index + boldLabels[0][0].length;
  const firstTail = text.slice(firstEnd, firstEnd + 4);
  const firstLooksHeading =
    /\b(?:stay|stays|base|hotel|accommodation|options?|recommendation|areas?)\b/i.test(boldLabels[0][1]) &&
    /[:\n]/.test(firstTail);
  if (firstLooksHeading && boldLabels.length >= 4) start = 1;

  const heading = text.slice(0, start ? boldLabels[start].index : boldLabels[0].index).trim();
  const bullets = [];
  for (let i = start; i < boldLabels.length; i += 1) {
    const match = boldLabels[i];
    const label = String(match[1] || "").replace(/:$/, "").trim();
    if (!label) continue;
    const bodyStart = match.index + match[0].length;
    const bodyEnd = i + 1 < boldLabels.length ? boldLabels[i + 1].index : text.length;
    const body = text
      .slice(bodyStart, bodyEnd)
      .replace(/^\s*(?:[:\-–—]\s*)?/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!body) continue;
    bullets.push(`- **${label}:** ${body}`);
  }
  if (bullets.length < 3) return text;
  console.log("[intake.controller] reformatted run-on accommodation recommendation to bullets");
  return [heading, bullets.join("\n")].filter(Boolean).join("\n").trim();
}

function enforceBulletedRecommendationFormat(decision) {
  if (!decision || typeof decision.replyText !== "string") return decision;
  const formatted = enforceBulletedAccommodationRecommendationText(decision.replyText);
  return formatted === decision.replyText ? decision : { ...decision, replyText: formatted };
}

function enforceBulletedTripSummaryFormat(decision) {
  if (!decision || typeof decision.replyText !== "string") return decision;
  const text = decision.replyText;
  if (!text) return decision;
  // Primary trigger: text contains the literal phrase "trip summary".
  // Secondary trigger: text starts with "Got it" / "Thanks for" /
  // "Updated trip" / "Here's the updated" — these are correction or
  // acknowledgement replies that the LLM sometimes produces as a single
  // run-on paragraph even though the system prompt mandates bullets.
  const hasTripSummaryPhrase = /\btrip\s+summary\b/i.test(text);
  const hasAckPrefix =
    /^(?:got it[—\-,]|thanks for the correction|updated trip summary|here'?s the updated)/i.test(text.trim());
  if (!hasTripSummaryPhrase && !hasAckPrefix) return decision;

  // Detect run-on: any line containing 2+ recognized field labels with colons.
  // The system prompt requires each field on its own bullet line.
  const lines = text.split("\n");
  let hasRunOn = false;
  for (const line of lines) {
    let count = 0;
    for (const label of TRIP_SUMMARY_FIELD_LABELS) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
      if (new RegExp(`\\b${escaped}:`).test(line)) count++;
      if (count >= 2) { hasRunOn = true; break; }
    }
    if (hasRunOn) break;
  }
  if (!hasRunOn) return decision;

  // Reformat: insert a newline + bullet before each field label that is not
  // already on its own line as a bullet. Lookbehind prevents double-bulleting
  // values that already start with "- **" (existing canonical output).
  let reformatted = text;
  for (const label of TRIP_SUMMARY_FIELD_LABELS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
    const rx = new RegExp(`(?<!\\n[-*]\\s\\*\\*)(?<!\\*\\*)\\b${escaped}:\\s*`, "g");
    reformatted = reformatted.replace(rx, `\n- **${label}:** `);
  }
  // Collapse 3+ newlines down to 2 to keep spacing tidy.
  reformatted = reformatted.replace(/\n{3,}/g, "\n\n");

  console.log("[intake.controller] reformatted run-on trip summary to bulleted form");
  return { ...decision, replyText: reformatted.trim() };
}

module.exports = {
  applyDestinationSwitchInheritance,
  buildCanonicalIntakeBlueprintReply,
  buildDestinationSwitchPrompt,
  buildTripSwitchFreshDetailsQuestion,
  detectDestinationSwitch,
  extractKnownMustVisitsFromText,
  extractPendingDestinationSwitch,
  llmFirstIntakeEnabled,
  previousAssistantAskedSwitchInheritance,
  processIntakeTurn,
};
