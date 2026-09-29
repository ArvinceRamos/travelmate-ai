// apps/functions/src/services/intake.understand.js
//
// Structured-output trip-understanding layer. The legacy regex-based
// mergePendingTripFromHistory still runs (for compatibility and as a
// safety fallback), but this module's output is preferred when
// available. The model decides what the user said — "el nido" is
// captured as a sub-area, "mid range" as a budget tier, "no idea" as
// an accepted assumption — without us having to grow another regex.
//
// Returns null on any error so callers fall through to the legacy
// regex pipeline. Set env STRUCTURED_INTAKE_UNDERSTANDING=0 to disable.

const { geocodeArea } = require("./maps.service");
const { settingsFor } = require("./aiProvider.service");

const DESTINATION_DENYLIST = new Set([
  "reply", "yes", "no", "ok", "okay", "sure", "this", "that", "here", "there",
  "please", "thanks", "anything", "something", "somewhere", "anywhere", "hello", "hi",
  // Verb / verb+article fragments. The LLM intake has hallucinated these as
  // destinations from sentences like "plan a 3-day trip to <X>" — free geocoder
  // then returned a fuzzy match (e.g. "Plan A, United States" or "Plan A,
  // Italy") which corrupted the trip state. Worldwide-safe: these are
  // English verbs/articles, not real cities.
  "plan", "plan a", "plan an", "plan the", "plan me", "plan us", "plan it",
  "make", "make a", "make an", "make the", "make me", "make us",
  "create", "create a", "create an", "create the", "create me",
  "build", "build a", "build an", "build the", "build me",
  "draft", "draft a", "draft an", "draft the",
  "generate", "generate a", "generate an", "generate the", "generate me",
  "find", "find a", "find an", "find the", "find me", "find us",
  "give", "give a", "give an", "give the", "give me", "give us",
  "show", "show a", "show an", "show the", "show me", "show us",
  "want", "want a", "want an", "want the", "want to",
  "need", "need a", "need an", "need the", "need to",
  "have", "have a", "have an", "have the",
  "get", "get a", "get an", "get the", "get me",
  "do", "do a", "do an", "do the", "do it",
  "help", "help me", "help us",
  "let", "let me", "let us",
  "tell", "tell me", "tell us",
  "an", "a", "the", "some",
  "trip", "tour", "vacation", "getaway", "itinerary", "travel", "holiday",
  "day", "days", "night", "nights", "weekend",
  "religious places", "tourist places", "famous places", "popular places",
]);

// Compact "verb + optional article" prefix that flags a destination candidate
// as coming from the user's request verb instead of an actual place name.
// Worldwide-safe: no city names hard-coded.
const VERB_DESTINATION_PREFIX_RX =
  /^(?:plan|planning|make|making|create|creating|build|building|draft|drafting|generate|generating|find|finding|give|giving|show|showing|want|wanting|need|needing|have|having|get|getting|do|doing|help|helping|let|tell|telling|book|booking|map|recommend|recommending|suggest|suggesting|i\s+am|i\s+m|we\s+are|we\s+re|you\s+are|you\s+re|its|it\s+s|that\s+is|this\s+is)(?:\s+(?:me|us|a|an|the|some|any))?\s*$/i;

// Known travel-destination → country map. Worldwide-safe coverage of major
// cities so a fuzzy geocode (e.g. Italian "Cebu", US "Manila") can be
// corrected without breaking other destinations. Only well-known travel
// hubs are listed; everything else falls through to the geocoder.
const KNOWN_DESTINATION_COUNTRY = {
  // Philippines
  cebu: "Philippines",
  manila: "Philippines",
  davao: "Philippines",
  iloilo: "Philippines",
  baguio: "Philippines",
  bohol: "Philippines",
  palawan: "Philippines",
  siargao: "Philippines",
  camiguin: "Philippines",
  boracay: "Philippines",
  bantayan: "Philippines",
  panglao: "Philippines",
  tagaytay: "Philippines",
  vigan: "Philippines",
  batanes: "Philippines",
  siquijor: "Philippines",
  moalboal: "Philippines",
  dumaguete: "Philippines",
  zamboanga: "Philippines",
  cagayan: "Philippines",
  "cagayan de oro": "Philippines",
  "puerto princesa": "Philippines",
  "el nido": "Philippines",
  "general luna": "Philippines",
  // Japan
  tokyo: "Japan",
  kyoto: "Japan",
  osaka: "Japan",
  okinawa: "Japan",
  hokkaido: "Japan",
  nara: "Japan",
  hiroshima: "Japan",
  // Thailand
  bangkok: "Thailand",
  phuket: "Thailand",
  "chiang mai": "Thailand",
  "koh samui": "Thailand",
  pattaya: "Thailand",
  // Vietnam
  hanoi: "Vietnam",
  "ho chi minh": "Vietnam",
  saigon: "Vietnam",
  "da nang": "Vietnam",
  "hoi an": "Vietnam",
  // Indonesia
  bali: "Indonesia",
  jakarta: "Indonesia",
  yogyakarta: "Indonesia",
  lombok: "Indonesia",
  // Malaysia, Singapore, HK, Korea, Taiwan
  "kuala lumpur": "Malaysia",
  penang: "Malaysia",
  langkawi: "Malaysia",
  singapore: "Singapore",
  "hong kong": "Hong Kong",
  macau: "Macau",
  seoul: "South Korea",
  busan: "South Korea",
  jeju: "South Korea",
  taipei: "Taiwan",
  // Europe / Americas / others — just enough to bias the obvious ones.
  paris: "France",
  london: "United Kingdom",
  rome: "Italy",
  florence: "Italy",
  venice: "Italy",
  milan: "Italy",
  barcelona: "Spain",
  madrid: "Spain",
  amsterdam: "Netherlands",
  berlin: "Germany",
  munich: "Germany",
  prague: "Czechia",
  vienna: "Austria",
  athens: "Greece",
  istanbul: "Turkey",
  dubai: "United Arab Emirates",
  "abu dhabi": "United Arab Emirates",
  "new york": "United States",
  "los angeles": "United States",
  "san francisco": "United States",
  chicago: "United States",
  miami: "United States",
  "las vegas": "United States",
  toronto: "Canada",
  vancouver: "Canada",
  sydney: "Australia",
  melbourne: "Australia",
  // Island countries + nations whose name is frequently misresolved by
  // fuzzy geocoders to UK / US / EU localities. Adding them locks the
  // country regardless of what free geocoder returns. Worldwide-safe — these
  // are real country names, not routing logic.
  maldives: "Maldives",
  male: "Maldives",
  "malé": "Maldives",
  maafushi: "Maldives",
  hulhumale: "Maldives",
  "hulhumalé": "Maldives",
  fiji: "Fiji",
  nadi: "Fiji",
  suva: "Fiji",
  tahiti: "French Polynesia",
  "french polynesia": "French Polynesia",
  bora: "French Polynesia",
  "bora bora": "French Polynesia",
  papeete: "French Polynesia",
  "new caledonia": "New Caledonia",
  noumea: "New Caledonia",
  vanuatu: "Vanuatu",
  samoa: "Samoa",
  tonga: "Tonga",
  palau: "Palau",
  guam: "Guam",
  saipan: "Northern Mariana Islands",
  // SE Asia extras
  "phnom penh": "Cambodia",
  "siem reap": "Cambodia",
  "angkor wat": "Cambodia",
  cambodia: "Cambodia",
  laos: "Laos",
  "luang prabang": "Laos",
  vientiane: "Laos",
  yangon: "Myanmar",
  myanmar: "Myanmar",
  bagan: "Myanmar",
  brunei: "Brunei",
  // South Asia
  india: "India",
  delhi: "India",
  mumbai: "India",
  goa: "India",
  jaipur: "India",
  bengaluru: "India",
  bangalore: "India",
  kerala: "India",
  agra: "India",
  varanasi: "India",
  "sri lanka": "Sri Lanka",
  colombo: "Sri Lanka",
  kandy: "Sri Lanka",
  galle: "Sri Lanka",
  nepal: "Nepal",
  kathmandu: "Nepal",
  pokhara: "Nepal",
  bhutan: "Bhutan",
  thimphu: "Bhutan",
  // Middle East
  jordan: "Jordan",
  petra: "Jordan",
  amman: "Jordan",
  qatar: "Qatar",
  doha: "Qatar",
  oman: "Oman",
  muscat: "Oman",
  // Africa
  morocco: "Morocco",
  marrakech: "Morocco",
  casablanca: "Morocco",
  fes: "Morocco",
  egypt: "Egypt",
  cairo: "Egypt",
  giza: "Egypt",
  luxor: "Egypt",
  kenya: "Kenya",
  nairobi: "Kenya",
  tanzania: "Tanzania",
  zanzibar: "Tanzania",
  "south africa": "South Africa",
  "cape town": "South Africa",
  johannesburg: "South Africa",
  // Europe extras
  lisbon: "Portugal",
  porto: "Portugal",
  copenhagen: "Denmark",
  stockholm: "Sweden",
  oslo: "Norway",
  helsinki: "Finland",
  reykjavik: "Iceland",
  iceland: "Iceland",
  budapest: "Hungary",
  warsaw: "Poland",
  krakow: "Poland",
  zurich: "Switzerland",
  geneva: "Switzerland",
  interlaken: "Switzerland",
  dublin: "Ireland",
  edinburgh: "United Kingdom",
  // Americas extras
  cancun: "Mexico",
  "mexico city": "Mexico",
  "tulum": "Mexico",
  "rio de janeiro": "Brazil",
  "sao paulo": "Brazil",
  "buenos aires": "Argentina",
  argentina: "Argentina",
  peru: "Peru",
  lima: "Peru",
  cusco: "Peru",
  "machu picchu": "Peru",
  havana: "Cuba",
  cuba: "Cuba",
  // Oceania extras
  auckland: "New Zealand",
  queenstown: "New Zealand",
  "gold coast": "Australia",
  cairns: "Australia",
  // Big country names typed directly so they map cleanly.
  philippines: "Philippines",
  japan: "Japan",
  thailand: "Thailand",
  vietnam: "Vietnam",
  indonesia: "Indonesia",
  malaysia: "Malaysia",
  taiwan: "Taiwan",
  france: "France",
  italy: "Italy",
  spain: "Spain",
  germany: "Germany",
  portugal: "Portugal",
  netherlands: "Netherlands",
  greece: "Greece",
  turkey: "Turkey",
  "united kingdom": "United Kingdom",
  uk: "United Kingdom",
  "united states": "United States",
  usa: "United States",
  canada: "Canada",
  australia: "Australia",
  "new zealand": "New Zealand",
  mexico: "Mexico",
  brazil: "Brazil",
};

// Region names that are NOT countries. The LLM/structured intake sometimes
// stamps these onto `country` (e.g. "Maldives Country in South Asia" → the
// user explained Maldives, and the model put country="South Asia"). Reject
// these so the country lock can take effect from the destination name.
const NON_COUNTRY_REGION_RX =
  /^(?:south\s*asia|southeast\s*asia|south[-\s]east\s*asia|east\s*asia|central\s*asia|west\s*asia|asia(?:\s*pacific)?|apac|emea|europe|eu|west\s*europe|western\s*europe|east\s*europe|eastern\s*europe|north\s*america|south\s*america|latin\s*america|central\s*america|middle\s*east|africa|sub[-\s]saharan\s*africa|north\s*africa|oceania|pacific|caribbean|scandinavia|nordic|balkans|mediterranean)$/i;

function isNonCountryRegion(value = "") {
  return NON_COUNTRY_REGION_RX.test(String(value || "").trim());
}

function inferCountryForKnownDestination(destination = "") {
  const key = String(destination || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!key) return "";
  if (KNOWN_DESTINATION_COUNTRY[key]) return KNOWN_DESTINATION_COUNTRY[key];
  // Also match the first significant token (e.g. "Cebu City" → "cebu",
  // "Mactan Cebu" → "cebu", "Tokyo Japan" → "tokyo").
  const tokens = key.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (KNOWN_DESTINATION_COUNTRY[token]) return KNOWN_DESTINATION_COUNTRY[token];
  }
  for (let i = 2; i <= Math.min(3, tokens.length); i += 1) {
    const phrase = tokens.slice(0, i).join(" ");
    if (KNOWN_DESTINATION_COUNTRY[phrase]) return KNOWN_DESTINATION_COUNTRY[phrase];
  }
  return "";
}

// Detects explicit country corrections the user typed ("its cebu philippines",
// "in japan", "in italy", "country is philippines", "cebu, philippines").
// Worldwide-safe — only triggers when a country word actually appears.
const EXPLICIT_COUNTRY_RX =
  /\b(?:philippines|japan|thailand|vietnam|indonesia|malaysia|singapore|hong\s*kong|macau|south\s*korea|korea|taiwan|china|usa|united\s*states|us|uk|united\s*kingdom|france|italy|spain|germany|portugal|netherlands|austria|czechia|greece|turkey|uae|united\s*arab\s*emirates|canada|australia|new\s*zealand|mexico|brazil)\b/i;

function extractExplicitCountryFromUserText(text = "") {
  const raw = String(text || "");
  if (!raw) return "";
  if (!EXPLICIT_COUNTRY_RX.test(raw)) return "";
  // Only return when the user actually phrases it as a country statement.
  if (!/\b(?:its|it'?s|in|to|from|country\s*(?:is|=|:)|i'?m\s+in|we'?re\s+in|cebu|manila|davao|bohol|palawan|boracay|camiguin|siargao|tokyo|kyoto|bangkok|bali|paris|london|new\s+york)\b/i.test(raw)) {
    return "";
  }
  const m = raw.match(EXPLICIT_COUNTRY_RX);
  const country = m ? String(m[0]).trim() : "";
  if (!country) return "";
  // Normalize to canonical name.
  const canon = country.toLowerCase().replace(/\s+/g, " ");
  if (/^philippines$/.test(canon)) return "Philippines";
  if (/^japan$/.test(canon)) return "Japan";
  if (/^thailand$/.test(canon)) return "Thailand";
  if (/^vietnam$/.test(canon)) return "Vietnam";
  if (/^indonesia$/.test(canon)) return "Indonesia";
  if (/^malaysia$/.test(canon)) return "Malaysia";
  if (/^singapore$/.test(canon)) return "Singapore";
  if (/^hong\s*kong$/.test(canon)) return "Hong Kong";
  if (/^macau$/.test(canon)) return "Macau";
  if (/^(?:south\s*korea|korea)$/.test(canon)) return "South Korea";
  if (/^taiwan$/.test(canon)) return "Taiwan";
  if (/^china$/.test(canon)) return "China";
  if (/^(?:usa|united\s*states|us)$/.test(canon)) return "United States";
  if (/^(?:uk|united\s*kingdom)$/.test(canon)) return "United Kingdom";
  if (/^france$/.test(canon)) return "France";
  if (/^italy$/.test(canon)) return "Italy";
  if (/^spain$/.test(canon)) return "Spain";
  if (/^germany$/.test(canon)) return "Germany";
  if (/^portugal$/.test(canon)) return "Portugal";
  if (/^netherlands$/.test(canon)) return "Netherlands";
  if (/^austria$/.test(canon)) return "Austria";
  if (/^czechia$/.test(canon)) return "Czechia";
  if (/^greece$/.test(canon)) return "Greece";
  if (/^turkey$/.test(canon)) return "Turkey";
  if (/^(?:uae|united\s*arab\s*emirates)$/.test(canon)) return "United Arab Emirates";
  if (/^canada$/.test(canon)) return "Canada";
  if (/^australia$/.test(canon)) return "Australia";
  if (/^new\s*zealand$/.test(canon)) return "New Zealand";
  if (/^mexico$/.test(canon)) return "Mexico";
  if (/^brazil$/.test(canon)) return "Brazil";
  return country.replace(/\b\w/g, (c) => c.toUpperCase());
}

const TRIP_UNDERSTANDING_JSON_SCHEMA = {
  name: "TripUnderstanding",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["updates", "userBehavior", "nextAction", "replyDraft"],
    properties: {
      updates: {
        type: "object",
        additionalProperties: false,
        description:
          "Extract ONLY facts the user actually stated or clearly accepted. Do NOT invent values from world knowledge — leave a field as null when the user has not stated it.",
        required: [
          "destination", "subArea", "country", "days", "date",
          "travelers", "budget", "theme", "origin", "startTime",
          "preTripTravel", "overnightBase", "itineraryStartDate", "itineraryStartTime", "itineraryStartPoint",
          "transportMode", "baseArea", "noHotelYet", "userAcceptsDefault",
          "isBroadDestination", "uncertainAbout", "breakfastMentioned"
        ],
        properties: {
          destination: { type: ["string", "null"], description: "Province/island/country level destination, e.g. 'Palawan', 'Cebu', 'Japan'." },
          subArea: { type: ["string", "null"], description: "Sub-area inside the destination, e.g. 'El Nido', 'Cebu City', 'Tokyo', 'Panglao / Alona Beach'." },
          country: { type: ["string", "null"] },
          days: { type: ["integer", "null"], minimum: 1, maximum: 60 },
          date: { type: ["string", "null"], description: "Date or month string the user gave, e.g. 'May 10', '2026-05-10', 'next weekend'." },
          travelers: { type: ["string", "null"], description: "One of: 'Solo' | 'With partner' | 'Family' | 'Friends' | 'Group' | '<N> Travelers' | 'Seniors'." },
          budget: { type: ["string", "null"], enum: ["budget", "mid-range", "luxury", null] },
          theme: { type: ["string", "null"], description: "Trip vibe in lower-case keyword(s): nature, beach, food, history, mixed, etc." },
          origin: { type: ["string", "null"] },
          startTime: { type: ["string", "null"], description: "HH:MM 24h or natural-language ('early morning', 'first ferry')." },
          preTripTravel: { type: ["string", "null"], description: "Travel before the itinerary's first day, e.g. 'Cebu → Manila flight, June 18 8pm'." },
          overnightBase: { type: ["string", "null"], description: "Overnight city/base before Day 1 starts, e.g. 'Manila overnight'." },
          itineraryStartDate: { type: ["string", "null"], description: "YYYY-MM-DD date where the itinerary itself starts." },
          itineraryStartTime: { type: ["string", "null"], description: "Short Day-1 start time only: early morning, morning, afternoon, evening, or HH:MM." },
          itineraryStartPoint: { type: ["string", "null"], description: "City/area where Day 1 actually starts, not necessarily the original origin." },
          transportMode: { type: ["string", "null"] },
          baseArea: { type: ["string", "null"] },
          noHotelYet: { type: ["boolean", "null"], description: "true when the user said they have no hotel/base yet." },
          userAcceptsDefault: { type: ["boolean", "null"], description: "true when the user said 'no idea' / 'you choose' / 'easiest route' / 'no preference'." },
          isBroadDestination: { type: ["boolean", "null"], description: "true when destination is province/island-group/country level and the user has not given a sub-area." },
          uncertainAbout: { type: "array", items: { type: "string" }, description: "Field names the user explicitly said they're unsure about (transport, base, time, origin, etc.)." },
          breakfastMentioned: { type: ["boolean", "null"] }
        }
      },
      userBehavior: {
        type: "object",
        additionalProperties: false,
        required: ["isFreshTripRequest", "isItineraryEdit", "isAccommodationLookup", "isPlaceStatusLookup"],
        properties: {
          isFreshTripRequest: { type: "boolean" },
          isItineraryEdit: { type: "boolean" },
          isAccommodationLookup: { type: "boolean" },
          isPlaceStatusLookup: { type: "boolean" }
        }
      },
      nextAction: {
        type: "string",
        enum: [
          "ask_destination",
          "ask_sub_area",
          "ask_duration",
          "ask_essentials",
          "ask_travelers",
          "ask_budget",
          "ask_theme",
          "ask_origin",
          "ask_origin_style",
          "ask_time_base",
          "ask_time",
          "ask_base",
          "ask_transport",
          "show_blueprint",
          "generate_itinerary",
          "answer_followup",
          "none"
        ]
      },
      replyDraft: {
        type: "string",
        description:
          "A short, conversational reply the assistant should send. Acknowledge the latest user info first, then ask only the remaining missing fields for nextAction, bundled as up to 3 short bullets when useful. If nextAction is show_blueprint, generate_itinerary, or answer_followup, leave this empty so the existing pipeline takes over."
      }
    }
  }
};

const SYSTEM_PROMPT = [
  "You are TravelMate AI's intake understanding model.",
  "Read the conversation and return a structured trip-state update plus the next conversational step.",
  "RULES:",
  "1. Extract ONLY what the user actually said. Never invent destinations, dates, or budgets. Leave a field null when the user has not stated it.",
  "1a. DESTINATION EXTRACTION (CRITICAL — worldwide): The destination is the place the trip is TO, not the user's request verb. Words like 'plan', 'plan a', 'make', 'make a', 'create', 'build', 'draft', 'generate', 'find', 'give', 'show', 'want', 'need', 'have', 'get', 'do', 'help', 'let me', 'tell me', 'a', 'an', 'the', 'trip', 'tour', 'vacation', 'itinerary', 'day', 'days', 'night', 'nights', 'weekend' are NEVER destinations. Theme phrases like 'religious places', 'famous places', 'tourist spots', 'beach spots', 'food places', 'churches', 'temples' are themes, not destinations. The destination is the actual geographic location in the same sentence — e.g. for 'plan a 3-day trip to religious places in cebu', destination='Cebu', theme='religious'. For 'plan me a trip in Tokyo with food spots', destination='Tokyo', theme='food'. For 'I want a 5-day vacation in Bali', destination='Bali'. If you cannot identify a real, capitalised, geographic place name in the user's text, leave destination=null — never put a verb, article, theme word, or noun phrase in destination.",
  "2. If the destination is a province / island group / country (Palawan, Cebu, Bohol, Japan, Thailand, Vietnam, Indonesia, Malaysia, South Korea, Philippines), set isBroadDestination=true UNTIL the user names a sub-area in their reply.",
  "3. When the user replies to a broad-area question with a sub-area (e.g. a town, island, city district, or coastal base), set updates.subArea AND set isBroadDestination=false.",
  "4. 'I don't know' / 'no idea' / 'you choose' / 'easiest' / 'no preference' / 'idk' / 'whatever you think' → userAcceptsDefault=true and add the unknown field name(s) to uncertainAbout.",
  "5. 'no hotels yet' / 'no base yet' / \"haven't booked a hotel\" / \"don't have a hotel\" → noHotelYet=true.",
  "6. Budget normalization (be tolerant of typos): 'mid range', 'midrange', 'mid-range', 'mid rang', 'mid-rang', 'mid ranged', 'midranged', 'medium', 'mid tier', 'middle' → budget='mid-range'. 'cheap' / 'low budget' / 'budget' / 'tight' / 'affordable' → 'budget'. 'luxury' / 'high-end' / 'high end' / 'premium' / 'lux' → 'luxury'.",
  "7. Group missing essentials in one ask: if date+travelers+budget are all missing, nextAction='ask_essentials'.",
  "8. After essentials are filled, prefer pairing: origin+style → 'ask_origin_style', time+base → 'ask_time_base'.",
  "9. Once destination, subArea (when needed), days, date, travelers, budget, theme, origin, startTime, baseArea-or-noHotelYet, and transportMode-or-uncertain are all known, set nextAction='show_blueprint' and leave replyDraft empty.",
  "9a. PRE-TRIP TRAVEL EXTRACTION: A flight, ferry, or bus that happens BEFORE the trip's first day is preTripTravel, NOT itineraryStartTime. Cues: 'flight leaves on <date> at <time>, stay overnight, then start on <next date>', 'we travel the day before', 'we arrive the night before'. Set preTripTravel, overnightBase, itineraryStartDate, itineraryStartTime, and itineraryStartPoint. itineraryStartPoint is the city where Day 1 actually starts, not the original origin. itineraryStartTime must always be a clock-style word ('early morning', 'morning', 'afternoon', 'evening') or HH:MM; never a full sentence.",
  "10. replyDraft RULES:",
  "    - Use warm, direct language. Vary the opening: \"Got it.\", \"Nice pick.\", \"Solid choice.\", \"Easy.\", \"Sounds fun.\" only when the latest user message contributes a real trip field.",
  "    - If the latest user message contributes zero trip fields, do not use destination/base acknowledgment phrases. Use a neutral opener like \"Happy to help — where are you headed?\" and ask up to 3 missing fields.",
  "    - Ask up to 3 missing useful details in one bundled list, following this priority: destination/sub-area → travel dates → trip length → travelers → budget → origin → start time → base.",
  "    - On the final missing field before the trip summary, ask one question. Otherwise default to 2–3 bundled bullets.",
  "    - BANNED EXACT PHRASES: never write \"I still need one key detail\" or \"I just need one more detail before I can show the trip summary\".",
  "    - No numbered choices. No long option strings. No itinerary headers. No map JSON.",
  "    - NEVER ask a field that already has a value in updates or in the recent conversation. If the user already gave the budget, do not ask the budget again.",
  "    - NEVER ask the same question twice across the conversation. Read the recentConversation array — if you would be repeating yourself, change tactic (move to the next missing field, or move to show_blueprint).",
  "    - When the user already confirmed they want generation (\"generate it\", \"yes go ahead\", \"build it now\", \"1\", \"do it\"), set nextAction='generate_itinerary' and leave replyDraft empty.",
  "11. If the user is editing an active itinerary OR asking for accommodations OR asking a place-status question, set userBehavior.* accordingly, nextAction='answer_followup', and leave replyDraft empty (the calling code routes it elsewhere)."
  ,"12. If the assistant asked whether the user meant Camiguin, Manjuyod, or another island and the user answers Camiguin, set destination='Camiguin', country='Philippines', isBroadDestination=false, and treat it as a fresh destination confirmation. Do not reuse any previous Bohol context."
  ,"13. Normalize clear Camiguin misspellings such as caniguin, camuguin, and camigin to destination='Camiguin', country='Philippines'. Never display those typos in summaries."
  ,"14. Keep destination, base area, and must-visit places separate. Base areas are towns, districts, beaches, ports, or hotel zones; landmarks, viewpoints, islands, waterfalls, heritage sites, and wildlife stops are must-visits."
].join("\n");

// Worldwide-safe: short structured fields (origin, startTime, date, budget,
// travelers) must never accept a full user sentence. The LLM intake has
// occasionally dumped the entire user message into one of these fields
// when the user said something compound — corrupting the trip state and
// triggering "ask again" loops. This validator caps length and rejects
// values that obviously contain multiple commas / verbs / fillers.
function isReasonableShortFieldValue(value = "", fieldName = "") {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  const commaCount = (raw.match(/,/g) || []).length;
  if (commaCount >= 2) return false; // Multi-clause sentence.
  if (raw.length > 80) return false;

  switch (fieldName) {
    case "startTime": {
      if (wordCount > 5) return false;
      if (!/^(?:early\s+morning|late\s+morning|morning|midday|noon|afternoon|early\s+afternoon|late\s+afternoon|evening|early\s+evening|late\s+evening|night|midnight|first\s+(?:ferry|flight|bus|van)|early|practical\s+morning(?:\s+start)?|\d{1,2}(?::\d{2})?\s*(?:am|pm|h)?|\d{1,2}\s*(?:o['’]?clock)?\s*(?:am|pm)?)\s*(?:start|departure|flight|departure\s+flight|flight\s+departure)?$/i.test(raw)) {
        return false;
      }
      return true;
    }
    case "origin": {
      if (wordCount > 6) return false;
      if (/\b(?:recommend|find|under|please|near|with\s+(?:friends|family|partner|partners)|budget|mid[-\s]?range|luxury|morning|afternoon|evening)\b/i.test(raw)) return false;
      return true;
    }
    case "date": {
      if (wordCount > 8) return false;
      if (/\b(?:recommend|under|please|with\s+friends|with\s+family|budget|morning|flight|airport)\b/i.test(raw)) return false;
      return true;
    }
    case "travelers": {
      if (wordCount > 4) return false;
      if (/\b(?:recommend|under|please|budget|morning|airport|flight)\b/i.test(raw)) return false;
      return true;
    }
    case "budget": {
      if (wordCount > 3) return false;
      return /^(?:budget|cheap|low[-\s]?budget|tight|affordable|mid[-\s]?rang(?:e|ed)?|midrang(?:e|ed)?|moderate|medium|standard|luxury|high[-\s]?end|premium|lux)$/i.test(raw);
    }
    default:
      return true;
  }
}

function understandingEnabled() {
  const raw = String(process.env.STRUCTURED_INTAKE_UNDERSTANDING || "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

const LOCKABLE_TRIP_FIELDS = ["style", "budget", "travelers", "origin", "startTime", "baseArea"];

const TRAVELER_NORMALIZATION = {
  "with my partner": "couple",
  "with my girlfriend": "couple",
  "with my boyfriend": "couple",
  "with my wife": "couple",
  "with my husband": "couple",
  "with my family": "family",
  "with friends": "friends",
  "solo": "solo",
  "alone": "solo",
  "by myself": "solo",
};

const MONTH_INDEX = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

function titleCaseSimplePlace(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((part) => {
      if (/^(?:PH|USA|UK)$/i.test(part)) return part.toUpperCase();
      return part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : "";
    })
    .join(" ");
}

function normalizeTravelerValue(value = "") {
  const raw = String(value || "").trim();
  const key = raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!key) return "";
  if (TRAVELER_NORMALIZATION[key]) return TRAVELER_NORMALIZATION[key];
  for (const [phrase, normalized] of Object.entries(TRAVELER_NORMALIZATION)) {
    if (new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(raw)) {
      return normalized;
    }
  }
  if (/\bpartner|girlfriend|boyfriend|wife|husband|couple|spouse\b/i.test(raw)) return "couple";
  if (/\bfamily|parents?|kids?|children\b/i.test(raw)) return "family";
  if (/\bfriends?|barkada\b/i.test(raw)) return "friends";
  if (/\bsolo|alone|by myself|just me\b/i.test(raw)) return "solo";
  const count = raw.match(/\b(\d+)\s*(?:pax|people|persons?|travelers?|travellers?)\b/i);
  if (count) return `${count[1]} travelers`;
  return raw;
}

function invalidUnderstandingBaseArea(value = "") {
  const raw = String(value || "").trim().replace(/\s+/g, " ");
  if (!raw) return false;
  const alphaCount = (raw.match(/[A-Za-z]/g) || []).length;
  if (alphaCount > 0 && alphaCount < 4) return true;
  if (/^(?:a|an|the|some|any)\b/i.test(raw)) return true;
  return /\b(?:idea|no idea|for now|recommend|suggest|whatever|you choose|pick one|whichever|no preference|not sure|tbd)\b/i.test(raw);
}

const DETERMINISTIC_TRANSPORT_MODE_RX =
  /\b(public\s+transport|public\s+transit|jeepney|tricycle|habal[\s-]?habal|bus|van|ferry|flight|private\s+car|grab|taxi|train|subway|metro|shuttle)\b/i;

const DETERMINISTIC_BASE_STOP_LOOKAHEAD = String.raw`(?=\s*(?:[,.;!?]|$)|\s+\b(?:also|and|plus|under|below|max(?:imum)?|up\s+to|no\s+more\s+than|public\s+transport|public\s+transit|jeepney|tricycle|habal[\s-]?habal|bus|van|ferry|flight|private\s+car|grab|taxi|train|subway|metro|shuttle)\b)`;

const DETERMINISTIC_BASE_RXES = [
  new RegExp(String.raw`\b(?:stay(?:ing)?|hotel|base|sleep|book(?:ing)?)\s+(?:at|in|near|around)\s+([\p{L}][\p{L}\p{M}'’.\- ]{1,40}?)${DETERMINISTIC_BASE_STOP_LOOKAHEAD}`, "iu"),
  new RegExp(String.raw`\bi\s*(?:'ll|’ll|will)\s+stay\s+(?:in|at|near|around)\s+([\p{L}][\p{L}\p{M}'’.\- ]{1,40}?)${DETERMINISTIC_BASE_STOP_LOOKAHEAD}`, "iu"),
  new RegExp(String.raw`\b(?:my\s+)?base\s+(?:is|will\s+be|should\s+be)\s+(?:in|at|near|around)?\s*([\p{L}][\p{L}\p{M}'’.\- ]{1,40}?)${DETERMINISTIC_BASE_STOP_LOOKAHEAD}`, "iu"),
];

function cleanDeterministicBaseCandidate(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+\b(?:under|below|max(?:imum)?|up\s+to|no\s+more\s+than)\b[\s\S]*$/i, "")
    .replace(/\s+\b(?:public\s+transport|public\s+transit|jeepney|tricycle|habal[\s-]?habal|bus|van|ferry|flight|private\s+car|grab|taxi|train|subway|metro|shuttle)\b[\s\S]*$/i, "")
    .replace(/\s+\b(?:also|and|plus)\b[\s\S]*$/i, "")
    .replace(/^[,;:\s]+|[,;:\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDeterministicBaseArea(text = "") {
  for (const rx of DETERMINISTIC_BASE_RXES) {
    const match = String(text || "").match(rx);
    const candidate = cleanDeterministicBaseCandidate(match?.[1] || "");
    if (candidate && !invalidUnderstandingBaseArea(candidate)) return titleCaseSimplePlace(candidate);
  }
  return "";
}

function extractDeterministicTransportMode(text = "") {
  const raw = String(text || "").match(DETERMINISTIC_TRANSPORT_MODE_RX)?.[1] || "";
  const mode = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!mode) return "";
  if (/^public\s+(?:transport|transit)$/.test(mode)) return "public transport";
  if (/^private\s+car$/.test(mode)) return "private car";
  if (/^habal/.test(mode)) return "habal-habal";
  if (mode === "flight") return "flight + local transfer";
  if (mode === "ferry") return "ferry + local transfer";
  return mode;
}

function normalizeDestinationCandidateKey(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDeniedDestinationCandidate(value = "") {
  const raw = String(value || "").trim();
  const key = normalizeDestinationCandidateKey(value);
  if (!key) return true;
  if (DESTINATION_DENYLIST.has(key)) return true;
  // Reject verb / verb+article fragments like "plan a", "make the", "show me",
  // "find a". These are not destinations; they are pieces of the user's
  // request verb that free geocoder will fuzzy-match to real (but irrelevant)
  // micro-places ("Plan A, United States"). Worldwide-safe — only English
  // verbs/articles, no city names.
  if (VERB_DESTINATION_PREFIX_RX.test(raw) || VERB_DESTINATION_PREFIX_RX.test(key)) return true;
  // Reject one-letter / two-letter "destinations" entirely.
  if (key.replace(/\s+/g, "").length < 3) return true;
  // Reject candidates that are nothing but a verb followed by an article and
  // a single short token — e.g. "plan a 3 day". free geocoder will still find a
  // place; we won't trust it.
  if (/^(?:plan|make|create|build|draft|generate|find|give|show|want|need|have|get|do|book|map|recommend|suggest)\s+(?:me|us|a|an|the|some|any)\s+\S+$/i.test(raw)) {
    return true;
  }
  return false;
}

function latestConfirmedDestinationFromRecent(recent = []) {
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const message = recent[i];
    if (!message || message.role !== "assistant") continue;
    const text = String(message.content || "");
    if (!previousAssistantLooksLikeBlueprint(text)) continue;
    const destination = extractBlueprintLineValue(text, ["Destination"]);
    if (destination) return stripAssumptionSuffix(destination);
  }
  return "";
}

async function geocodeDestinationConfidence(value = "") {
  const candidate = String(value || "").trim();
  if (!candidate || isDeniedDestinationCandidate(candidate)) {
    return { accepted: false, confidence: 0, reason: "denylisted_destination" };
  }

  // Worldwide-safe length+complexity floor. A 1-token, all-lowercase
  // candidate (e.g. "plan", "a", "trip") that the LLM proposes should not
  // be trusted even if free geocoder finds something fuzzy. Real destinations are
  // either multi-word ("New York") or a capitalised proper noun the user
  // typed deliberately.
  const wordCount = candidate.split(/\s+/).filter(Boolean).length;
  const lettersOnly = candidate.replace(/[^A-Za-z]/g, "");
  const looksLikeBareLowercaseFragment =
    wordCount <= 2 && lettersOnly.length <= 6 && /^[a-z\s]+$/.test(candidate);
  if (looksLikeBareLowercaseFragment) {
    return { accepted: false, confidence: 0, reason: "low_quality_candidate" };
  }

  try {
    const result = typeof geocodeArea === "function"
      ? await geocodeArea(candidate, { providerTimeoutMs: 8000 })
      : null;
    const confidence = Number(result?.confidence);
    // Short candidates (1-2 short words) need a much higher geocode
    // confidence to be trusted, because free geocoder will fuzzy-match almost
    // anything to a real micro-place somewhere in the world.
    const threshold = wordCount <= 2 ? 0.9 : 0.7;
    if (Number.isFinite(confidence) && confidence >= threshold) {
      return { accepted: true, confidence, reason: "" };
    }
    return {
      accepted: false,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      reason: result ? "low_geocode_confidence" : "geocode_unavailable",
    };
  } catch (e) {
    return { accepted: false, confidence: 0, reason: "geocode_error" };
  }
}

async function validateDestinationUpdates(updates = {}, { recent = [], latestUser = "" } = {}) {
  const next = { ...(updates || {}) };
  const priorDestination = latestConfirmedDestinationFromRecent(recent);
  const latestExplicitlyChangesDestination = latestUserRequestsTripLockReset(latestUser) ||
    /\b(?:destination|place|area)\s+(?:is|should\s+be|was|to)\b/i.test(String(latestUser || ""));
  let priorCheck = null;

  for (const field of ["destination", "subArea"]) {
    const value = String(next[field] || "").trim();
    if (!value) continue;
    if (isDeniedDestinationCandidate(value)) {
      console.warn("[intake.understand] rejected destination candidate", {
        field,
        value,
        reason: "denylisted_destination",
      });
      next[field] = null;
      continue;
    }
    if (field !== "destination") continue;

    const check = await geocodeDestinationConfidence(value);
    if (!check.accepted) {
      console.warn("[intake.understand] rejected destination candidate", {
        field,
        value,
        reason: check.reason,
      });
      next[field] = null;
      continue;
    }
    if (
      priorDestination &&
      !latestExplicitlyChangesDestination &&
      check.accepted
    ) {
      priorCheck = priorCheck || await geocodeDestinationConfidence(priorDestination);
    }
    if (
      priorDestination &&
      !latestExplicitlyChangesDestination &&
      priorCheck?.accepted &&
      check.confidence < priorCheck.confidence
    ) {
      console.warn("[intake.understand] kept locked destination over lower-confidence candidate", {
        field,
        value,
        confidence: check.confidence,
        priorDestination,
        priorConfidence: priorCheck.confidence,
      });
      next[field] = null;
    }
  }

  return next;
}

function inferYearForMonthDay(month, day, appContext = {}) {
  const todayISO = String(appContext?.todayISO || "").trim();
  const now = todayISO.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    ? new Date(`${todayISO}T12:00:00Z`)
    : new Date();
  let year = now.getUTCFullYear();
  // Roll forward when the candidate month/day is today OR earlier. A user
  // typing "may 19" on May 19 itself is almost always planning the NEXT
  // May 19, not today (the morning is already gone and trip intake takes
  // multiple turns). Compare just (month, day) against today's (month, day)
  // so the comparison is timezone-/time-of-day-independent.
  const todayMonth = now.getUTCMonth() + 1;
  const todayDay = now.getUTCDate();
  const candidateOrdinal = month * 100 + day;
  const todayOrdinal = todayMonth * 100 + todayDay;
  if (candidateOrdinal <= todayOrdinal) year += 1;
  return year;
}

function parseNaturalDateFromText(text = "", appContext = {}) {
  const raw = String(text || "");
  const match = raw.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\b/i);
  if (!match) return "";
  const month = MONTH_INDEX[String(match[1] || "").toLowerCase().replace(/\.$/, "")];
  const day = Number(match[2]);
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) return "";
  // Worldwide-safe year qualifier parsing. If the user adds "next year",
  // "this year", or "in YYYY" near the month-day phrase, honor it. Without
  // this, "may 19 next year" was being parsed as the current year — which
  // can resolve to a past date (e.g. May 19 2026 typed in late May 2026).
  let year;
  if (match[3]) {
    year = Number(match[3]);
  } else {
    const todayISO = String(appContext?.todayISO || "").trim();
    const now = todayISO.match(/^(\d{4})-(\d{2})-(\d{2})$/)
      ? new Date(`${todayISO}T12:00:00Z`)
      : new Date();
    const currentYear = now.getUTCFullYear();
    // Look for a year qualifier within 60 chars of the matched date phrase.
    const windowStart = Math.max(0, match.index - 30);
    const windowEnd = Math.min(raw.length, match.index + match[0].length + 60);
    const nearby = raw.slice(windowStart, windowEnd);
    if (/\bnext\s+year\b/i.test(nearby)) {
      year = currentYear + 1;
    } else if (/\bthis\s+year\b/i.test(nearby)) {
      year = currentYear;
    } else {
      const explicitYear = nearby.match(/\bin\s+(20\d{2})\b/i);
      if (explicitYear) {
        year = Number(explicitYear[1]);
      } else {
        year = inferYearForMonthDay(month, day, appContext);
      }
    }
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeCebuPlace(value = "") {
  const clean = titleCaseSimplePlace(value)
    .replace(/\bSta\.?\s+Fe\b/i, "Sta. Fe")
    .replace(/\bSanta\s+Fe\b/i, "Santa Fe")
    .replace(/\bCebu\b/i, "Cebu");
  if (/^mandaue(?:\s+cebu)?$/i.test(clean)) return "Mandaue, Cebu";
  return clean;
}

function extractDeterministicTripFieldsFromText(text = "", appContext = {}) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  const updates = {};
  if (!raw) return updates;

  const duration =
    raw.match(/\b(\d{1,2})\s*(?:days?|day|nights?|night)\b/i) ||
    raw.match(/\b(?:have|take|plan|make|build|create|want)\s+(?:a\s+)?(\d{1,2})\s+(?=(?:relax(?:ation|ing)?|beach|nature|adventure|food|history|church|romantic|couple|family|budget|mid[-\s]?range|luxury)\s+trip\b)/i);
  if (duration) {
    const days = Number(duration[1]);
    if (Number.isInteger(days) && days > 0) updates.days = days;
  }

  const date = parseNaturalDateFromText(raw, appContext);
  if (date) updates.date = date;

  // Year-only / month+year correction. When the user corrects only the year
  // ("the date should be may 2027", "make it 2027", "next year") and no full
  // month-day phrase is present, surface the implied year so the merge step
  // can preserve the existing day + duration and only swap the year.
  if (!date) {
    const monthYear = raw.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(20\d{2})\b/i);
    if (monthYear) {
      const monthIdx = MONTH_INDEX[String(monthYear[1] || "").toLowerCase().replace(/\.$/, "")];
      const yr = Number(monthYear[2]);
      if (monthIdx && Number.isFinite(yr)) {
        updates.dateYearOverride = yr;
        updates.dateMonthOverride = monthIdx;
      }
    } else {
      const bareYear = raw.match(/\b(?:in|on|date(?:s)?(?:\s+(?:should\s+be|is|are))?\s+|make\s+it\s+|change\s+(?:it\s+)?to\s+|update\s+to\s+|the\s+year\s+(?:should\s+be|is)?\s*|year:\s*)(20\d{2})\b/i);
      if (bareYear) {
        const yr = Number(bareYear[1]);
        if (Number.isFinite(yr)) updates.dateYearOverride = yr;
      } else if (/\bnext\s+year\b/i.test(raw)) {
        const todayISO = String(appContext?.todayISO || "").trim();
        const now = todayISO.match(/^(\d{4})-(\d{2})-(\d{2})$/)
          ? new Date(`${todayISO}T12:00:00Z`)
          : new Date();
        updates.dateYearOverride = now.getUTCFullYear() + 1;
      }
    }
  }

  if (/\brelax(?:ation|ing)?\b/i.test(raw)) updates.theme = "relaxation";
  else if (/\bchurch(?:es)?|religious|pilgrim\b/i.test(raw)) updates.theme = "churches";
  else if (/\bbeach(?:es)?\b/i.test(raw)) updates.theme = "beach";
  else if (/\bnature\b/i.test(raw)) updates.theme = "nature";

  const destMatch = raw.match(/\b(?:trip|travel|go|going|visit|itinerary)\s+(?:in|to|for)\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=\s+from\b|\s+on\b|\s+with\b|\s+and\b|[,.;!?]|$)/i);
  if (destMatch?.[1]) {
    const candidate = String(destMatch[1] || "").trim();
    // Theme phrases like "religious places in cebu" should yield the city
    // (cebu) as the destination, not the theme. Walk back from the end and
    // collapse "<theme> in <city>" / "<theme> at <city>" / "<theme> near
    // <city>" to just <city>.
    const cityTail = candidate.match(/\b(?:in|at|near|around)\s+([A-Za-z][A-Za-z .'-]{1,40})$/i);
    const cleanedCandidate = cityTail ? cityTail[1].trim() : candidate;
    const dest = normalizeCebuPlace(cleanedCandidate);
    const destKey = dest.toLowerCase().replace(/\s+/g, " ").trim();
    // Skip generic theme/category labels that are not real places.
    const looksLikeThemeNotPlace =
      /\b(?:places?|spots?|stops?|attractions?|sights?|landmarks?|sites?|areas?|destinations?|things?|activities?|tours?|trips?|itineraries?|food|foods|nightlife|shopping|beaches?|churches?|temples?|heritage|history|nature)\b/i.test(dest) &&
      !/\b(?:cebu|manila|baguio|davao|iloilo|bohol|palawan|siargao|boracay|tagaytay|tokyo|kyoto|osaka|bangkok|singapore|seoul|paris|london|rome|bali|hanoi|saigon|hong\s*kong|new\s+york|los\s+angeles)\b/i.test(dest);
    if (dest && !looksLikeThemeNotPlace && destKey.length >= 3) {
      updates.destination = dest;
      if (/\bcebu\b/i.test(dest)) updates.country = "Philippines";
    } else if (/\bcebu\b/i.test(raw)) {
      updates.destination = "Cebu";
      updates.country = "Philippines";
    }
  } else if (/\bcebu\b/i.test(raw)) {
    updates.destination = "Cebu";
    updates.country = "Philippines";
  }

  // Stop the origin capture at any clause connector — not just "and/also/too"
  // — so "i am from cebu so i dont need a hotel, morning" yields "cebu"
  // instead of "Cebu So I Dont Need A Hotel". Also stop on "is/are" because
  // "from cebu is fine" should still capture just "cebu". Also strip
  // trailing single-word qualifiers ("cebu only", "cebu please", "cebu now")
  // so the displayed origin reads as a clean place name.
  const ORIGIN_STOP_LOOKAHEAD =
    "(?=\\s+(?:and|also|too|as\\s+well|so|since|because|but|only|now|please|pls|with|for|to|then|while|though|although|if|when|that|which|who|where|while|by|via|using|para|kay)\\b|[,.;!?]|$)";
  const originMatch = raw.match(new RegExp(`\\b(?:i'?m|im|i am|we'?re|we are)\\s+from\\s+([A-Za-z][A-Za-z .'-]{1,60}?)${ORIGIN_STOP_LOOKAHEAD}`, "i")) ||
    raw.match(new RegExp(`\\b(?:origin|starting point|starting from|from)\\s*(?:is|=|:)?\\s+([A-Za-z][A-Za-z .'-]{1,60}?)${ORIGIN_STOP_LOOKAHEAD}`, "i"));
  if (originMatch?.[1]) {
    // Strip trailing connector/qualifier words that bled into the capture
    // ("cebu also" → "cebu", "cebu only" → "cebu", "manila please" → "manila").
    const cleanOrigin = String(originMatch[1] || "")
      .replace(/\s+(?:also|too|as\s+well|please|pls|now|only|just|alone|exclusively|naman|lang|man|gud|ra)\s*$/i, "")
      .trim();
    if (cleanOrigin && !/^(?:so|since|because|but|only|just|now|please|pls|the|a|an)$/i.test(cleanOrigin)) {
      updates.origin = normalizeCebuPlace(cleanOrigin);
    }
  }

  // Worldwide-safe budget tier extraction. Catches the bare one-word
  // answer "budget" (which the user gives when answering "What budget
  // should I follow — budget, mid-range, or luxury?"). Without this, the
  // LLM intake silently defaults to "mid-range" because no deterministic
  // budget value was provided, overriding the user's explicit answer.
  if (/^(?:budget|cheap|tight|affordable|low[-\s]?budget|budget[-\s]?friendly)\s*\.?\s*$/i.test(raw) ||
      /\b(?:on\s+(?:a|the|our|my)\s+budget|low[-\s]?budget|cheap|budget\s+trip|budget[-\s]?friendly|tight\s+budget)\b/i.test(raw) ||
      /^budget\b/i.test(raw)) {
    updates.budget = "budget";
  } else if (/^(?:mid[-\s]?rang(?:e|ed)?|midrang(?:e|ed)?|medium|mid[-\s]?tier|middle)\s*\.?\s*$/i.test(raw) ||
             /\b(?:mid[-\s]?rang(?:e|ed)?|midrang(?:e|ed)?|medium\s+budget|mid[-\s]?tier|middle\s+budget)\b/i.test(raw)) {
    updates.budget = "mid-range";
  } else if (/^(?:luxury|lux|high[-\s]?end|premium)\s*\.?\s*$/i.test(raw) ||
             /\b(?:luxury|high[-\s]?end|premium|high\s+budget|big\s+budget)\b/i.test(raw)) {
    updates.budget = "luxury";
  }

  const traveler = normalizeTravelerValue(raw);
  if (["couple", "family", "friends", "solo"].includes(traveler) || /\d+\s+travelers/i.test(traveler)) {
    updates.travelers = traveler;
  }

  const santaFeOnly = raw.match(/^\s*(?:sta\.?\s*fe|santa\s+fe)\b/i);
  if (santaFeOnly) {
    updates.subArea = /santa/i.test(santaFeOnly[0]) ? "Santa Fe" : "Sta. Fe";
    updates.baseArea = updates.subArea;
  }

  const baseArea = extractDeterministicBaseArea(raw);
  if (baseArea) updates.baseArea = baseArea;

  const transportMode = extractDeterministicTransportMode(raw);
  if (transportMode) updates.transportMode = transportMode;

  const preTripStart = raw.match(/\bstart(?:ing)?\s+(?:on\s+|in\s+)?((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?)?\s*(early\s+morning|morning|afternoon|evening|night|\d{1,2}(?::\d{2})?\s*(?:am|pm))?/i);
  if (
    /\b(?:flight|fly|plane|ferry|bus|van)\b/i.test(raw) &&
    /\b(?:overnight|stay(?:ing)?|hotel|rest)\b/i.test(raw) &&
    preTripStart
  ) {
    const stayCity =
      (raw.match(/\bstay(?:ing)?\s+(?:in|at)\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=\s+(?:to|so|for|overnight|and)\b|[,.;]|$)/i) || [])[1] ||
      (raw.match(/\bhotel\s+in\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=\s+(?:to|so|for|overnight|and)\b|[,.;]|$)/i) || [])[1] ||
      "Manila";
    const city = titleCaseSimplePlace(stayCity);
    const travelTime = (raw.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i) || [])[0] || "";
    const travelDateText = (raw.match(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?\b/i) || [])[0] || "";
    const mode = /\bferr(?:y|ies)\b/i.test(raw) ? "ferry" : /\bbus\b/i.test(raw) ? "bus" : /\bvan\b/i.test(raw) ? "van" : "flight";
    updates.preTripTravel = [
      updates.origin && city ? `${updates.origin} → ${city}` : city ? `to ${city}` : "",
      mode,
      [travelDateText, travelTime ? travelTime.toUpperCase().replace(/\s+/, " ") : ""].filter(Boolean).join(" "),
    ].filter(Boolean).join(", ");
    updates.overnightBase = city ? `${city} overnight` : null;
    updates.itineraryStartDate = preTripStart[1] ? parseNaturalDateFromText(preTripStart[1], appContext) : null;
    updates.itineraryStartTime = preTripStart[2] ? String(preTripStart[2]).toLowerCase() : null;
    updates.itineraryStartPoint = city || null;
    if (updates.itineraryStartDate) updates.date = updates.itineraryStartDate;
    if (updates.itineraryStartTime) updates.startTime = updates.itineraryStartTime;
  }

  if (/\b(?:no\s+(?:hotel|base(?:\s+area)?|place|stay)|haven'?t\s+booked|(?:don'?t|dont|do\s+not)\s+have\s+(?:a\s+|any\s+)?(?:hotel|base(?:\s+area)?|place|stay)|(?:we|i)\s+have\s+no\s+(?:hotel|base(?:\s+area)?|place|stay))\b/i.test(lower)) {
    updates.noHotelYet = true;
  }

  return updates;
}

function mergeUnderstandingUpdates(modelUpdates = {}, deterministicUpdates = {}) {
  const merged = { ...(modelUpdates || {}) };
  for (const [key, value] of Object.entries(deterministicUpdates || {})) {
    if (value !== null && value !== undefined && value !== "") merged[key] = value;
  }
  if (merged.travelers) merged.travelers = normalizeTravelerValue(merged.travelers);
  return merged;
}

function recentHasGeneratedItinerary(messages = []) {
  return (Array.isArray(messages) ? messages : []).some((m) => {
    const text = String(m?.content || "");
    return (
      m?.role === "assistant" &&
      /^Day\s+\d+\s+[—-]/im.test(text) &&
      /<<<MAP_STOPS_JSON>>>/i.test(text)
    );
  });
}

function looksLikePostItineraryContentQuestion(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (latestUserRequestsTripLockReset(t)) return false;
  if (/\b(?:new\s+trip|fresh\s+trip|new\s+destination|start\s+over|reset|plan\s+(?:a|another|new)|create\s+(?:a|another|new)|build\s+(?:a|another|new))\b/i.test(t)) {
    return false;
  }
  return /\b(?:transport|transportation|route|commute|directions?|cost|costs|price|prices|fare|fares|budget|hotel|hotels|accommodation|where\s+to\s+stay|breakdown|details?|detailed|provide\s+me|tell\s+me|how\s+much|how\s+to\s+get|getting\s+around)\b/i.test(t);
}

function normalizeLockText(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function previousAssistantLooksLikeBlueprint(text = "") {
  const t = String(text || "");
  if (!t) return false;
  return (
    /\btrip summary before I build it\b/i.test(t) &&
    /\bshould I generate (?:the full itinerary|the updated \d{1,2}-day itinerary|this itinerary for you) now\??/i.test(t)
  ) || (
    /\bhere'?s the trip summary before I build it\b/i.test(t) &&
    /\bshould I generate\b/i.test(t)
  );
}

function looksLikeBlueprintConfirmation(text = "") {
  const t = normalizeLockText(text);
  if (!t) return false;
  return /^(?:yes|yes please|yep|yeah|yup|sure|ok|okay|please|go|go ahead|proceed|do it|generate|generate it|generate now|build it|make it|sige|ge|okay na|buhata na|padayon|sige na|ok ra)(?: please)?$/.test(t);
}

function latestUserRequestsTripLockReset(text = "") {
  return /\b(?:start\s+over|reset(?:\s+the\s+trip)?|new\s+trip|fresh\s+trip|new\s+destination\s*:|change\s+(?:the\s+)?destination\s+to|destination\s+(?:is|should\s+be)\s+now)\b/i.test(
    String(text || "")
  );
}

function latestUserExplicitlyMentionsDate(text = "") {
  const t = String(text || "");
  if (!t) return false;
  // Any month-name + day, ISO date, or explicit year correction qualifies.
  return /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(t) ||
    /\b\d{4}-\d{1,2}-\d{1,2}\b/.test(t) ||
    /\b(?:date|year|next\s+year|this\s+year|move\s+(?:it|the\s+date))\b/i.test(t);
}

function latestUserExplicitlyChangesLockedField(text = "", field = "") {
  const t = String(text || "");
  if (!t) return false;
  if (latestUserRequestsTripLockReset(t)) return true;

  const fieldPatterns = {
    style: /\b(?:change|switch|set|update|make)\s+(?:the\s+)?(?:style|theme|vibe|pace|focus)\s+(?:to|into|as)\b/i,
    budget: /\b(?:change|switch|set|update|make)\s+(?:the\s+)?budget\s+(?:to|into|as)\b|\b(?:budget\s+(?:is|should\s+be)\s+(?:now\s+)?)\b/i,
    travelers: /\b(?:change|switch|set|update)\s+(?:the\s+)?(?:travelers?|travellers?|pax|people)\s+(?:to|into|as)\b|\b(?:now|actually)\s+(?:solo|with\s+(?:my\s+)?(?:partner|family|friends)|\d+\s+(?:pax|people|travelers?))\b/i,
    origin: /\b(?:change|switch|set|update)\s+(?:the\s+)?(?:origin|starting\s+point|start\s+location)\s+(?:to|into|as)\b|\b(?:origin|starting\s+point)\s+(?:is|should\s+be)\s+(?:now\s+)?\b/i,
    startTime: /\b(?:change|switch|set|update|make)\s+(?:the\s+)?(?:start\s*time|departure\s*time|arrival\s*time|time)\s+(?:to|into|as)\b|\b(?:start|leave|depart|arrive)\s+(?:at|around)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
    baseArea: /\b(?:change|switch|set|update)\s+(?:the\s+)?(?:base|hotel|accommodation|stay\s+area)\s+(?:to|into|as)\b|\b(?:base|hotel|accommodation)\s+(?:is|should\s+be)\s+(?:now\s+)?\b/i,
  };
  return Boolean(fieldPatterns[field]?.test(t));
}

function extractBlueprintLineValue(text = "", labels = []) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.trim();
    if (!cleaned) continue;
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\//g, "\\s*\\/\\s*");
      const rx = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*:\\s*(.+?)\\s*$`, "i");
      const match = cleaned.match(rx);
      if (match?.[1]) return match[1].trim();
    }
  }
  return "";
}

function stripAssumptionSuffix(value = "") {
  return String(value || "")
    .replace(/\s*\((?:assumption accepted|assumed|default)\)\s*$/i, "")
    .trim();
}

function extractLockedTripFieldsFromBlueprint(text = "") {
  const values = {
    style: stripAssumptionSuffix(extractBlueprintLineValue(text, ["Style", "Theme", "Purpose"])),
    budget: stripAssumptionSuffix(extractBlueprintLineValue(text, ["Budget"])),
    travelers: stripAssumptionSuffix(extractBlueprintLineValue(text, ["Travelers", "Travellers"])),
    origin: stripAssumptionSuffix(extractBlueprintLineValue(text, ["Origin", "Starting point"])),
    startTime: stripAssumptionSuffix(extractBlueprintLineValue(text, ["Start", "Start time", "Departure", "Arrival"])),
    baseArea: stripAssumptionSuffix(extractBlueprintLineValue(text, ["Hotel/base", "Base", "Accommodation"])),
  };

  const locked = {};
  for (const field of LOCKABLE_TRIP_FIELDS) locked[field] = true;
  return { locked, values };
}

function getConfirmedBlueprintLocksFromRecent(recent = []) {
  let latest = null;
  for (let i = 1; i < recent.length; i += 1) {
    const current = recent[i];
    const previous = recent[i - 1];
    if (
      current?.role === "user" &&
      previous?.role === "assistant" &&
      previousAssistantLooksLikeBlueprint(previous.content) &&
      looksLikeBlueprintConfirmation(current.content)
    ) {
      latest = {
        ...extractLockedTripFieldsFromBlueprint(previous.content),
        confirmedAt: i,
      };
    }
  }
  return latest;
}

function ensureLockedTripState(merged) {
  if (!merged.locked || typeof merged.locked !== "object") merged.locked = {};
  if (!merged.lockedValues || typeof merged.lockedValues !== "object") merged.lockedValues = {};
}

function applyLockedTripFieldValue(merged, field, value) {
  const clean = stripAssumptionSuffix(value);
  if (!clean) return;
  if (field === "style") {
    merged.theme = clean;
    merged.interests = true;
  } else if (field === "budget") {
    merged.budget = clean.toLowerCase();
  } else if (field === "travelers") {
    merged.travelers = normalizeTravelerValue(clean) || clean;
  } else if (field === "origin") {
    merged.origin = clean;
  } else if (field === "startTime") {
    merged.startTime = clean;
  } else if (field === "baseArea") {
    if (/not needed|local trip|none/i.test(clean)) {
      merged.baseStatus = "none";
    } else {
      merged.baseArea = clean;
      merged.baseStatus = "provided";
    }
  }
}

async function understandTripIntent(client, { messages = [], appContext = {} } = {}) {
  if (!client || !understandingEnabled()) return null;

  const recent = [...messages]
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-12)
    .map((m) => ({
      role: m.role,
      content: String(m.content || "").replace(/\s+/g, " ").trim().slice(0, 900)
    }));
  if (!recent.length) return null;

  const model = String(
    process.env.AI_MODEL || settingsFor().model
  ).trim();

  try {
    const completion = await client.chat.completions.create({
      model,
      max_completion_tokens: 700,
      response_format: { type: "json_schema", json_schema: TRIP_UNDERSTANDING_JSON_SCHEMA },
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

    const raw = completion?.choices?.[0]?.message?.content || "";
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.updates || !parsed.userBehavior || !parsed.nextAction) return null;

    const latestUser = [...recent].reverse().find((m) => m.role === "user")?.content || "";
    const deterministicUpdates = extractDeterministicTripFieldsFromText(latestUser, appContext);
    parsed.updates = mergeUnderstandingUpdates(parsed.updates, deterministicUpdates);
    parsed.updates = await validateDestinationUpdates(parsed.updates, { recent, latestUser });
    if (recentHasGeneratedItinerary(recent) && looksLikePostItineraryContentQuestion(latestUser)) {
      parsed.userBehavior = {
        ...(parsed.userBehavior || {}),
        isFreshTripRequest: false,
        isItineraryEdit: false,
      };
      parsed.nextAction = "answer_followup";
      parsed.replyDraft = "";
    }
    parsed._latestUserText = latestUser;
    parsed._lockedTripFieldsFromHistory = latestUserRequestsTripLockReset(latestUser)
      ? null
      : getConfirmedBlueprintLocksFromRecent(recent);
    const previous = recent.length >= 2 ? recent[recent.length - 2] : null;
    parsed._confirmedBlueprintLock =
      parsed.nextAction === "generate_itinerary" &&
      previous?.role === "assistant" &&
      previousAssistantLooksLikeBlueprint(previous.content) &&
      looksLikeBlueprintConfirmation(latestUser);

    return parsed;
  } catch (error) {
    console.warn("[intake.understand] failed", { err: String(error?.message || error || "") });
    return null;
  }
}

// Merge a TripUnderstanding result into the regex-derived `merged` state.
// Rule of thumb: regex wins for fields it already filled (deterministic
// and cheap), the model wins for empty fields and for fields the user
// just changed in their latest turn (sub-area, accepted-default).
function applyTripUnderstandingToMerged(merged, understanding) {
  if (!merged || !understanding) return;
  const u = understanding.updates || {};
  const latestUserText = String(understanding._latestUserText || "");
  const resetLocks = latestUserRequestsTripLockReset(latestUserText);
  ensureLockedTripState(merged);

  if (resetLocks) {
    merged.locked = {};
    merged.lockedValues = {};
  } else {
    const historyLocks = understanding._lockedTripFieldsFromHistory || null;
    if (historyLocks?.locked) {
      for (const field of LOCKABLE_TRIP_FIELDS) {
        if (historyLocks.locked[field]) merged.locked[field] = true;
      }
    }
    if (historyLocks?.values) {
      for (const field of LOCKABLE_TRIP_FIELDS) {
        const value = historyLocks.values[field];
        if (value) merged.lockedValues[field] = value;
      }
    }
    if (understanding._confirmedBlueprintLock) {
      const currentValues = {
        style: merged.theme,
        budget: merged.budget,
        travelers: merged.travelers,
        origin: merged.origin,
        startTime: merged.startTime || merged.departureTime || merged.arrivalTime,
        baseArea: merged.baseArea || (merged.baseStatus === "none" ? "Not needed / local trip" : ""),
      };
      for (const field of LOCKABLE_TRIP_FIELDS) {
        merged.locked[field] = true;
        if (currentValues[field]) merged.lockedValues[field] = currentValues[field];
      }
    }

    for (const field of LOCKABLE_TRIP_FIELDS) {
      if (merged.locked[field] && !latestUserExplicitlyChangesLockedField(latestUserText, field)) {
        applyLockedTripFieldValue(merged, field, merged.lockedValues[field]);
      }
    }
  }

  const canApplyLockedField = (field) =>
    !merged.locked?.[field] || latestUserExplicitlyChangesLockedField(latestUserText, field);

  if (u.subArea) {
    const subArea = String(u.subArea).trim();
    if (subArea) {
      merged.anchorPlace = subArea;
      if (merged.acceptedAssumptions instanceof Set) {
        merged.acceptedAssumptions.add("broadArea");
      }
    }
  }
  if (u.destination && !merged.destinationName) {
    merged.destinationName = String(u.destination).trim();
    merged.destination = true;
  }
  // Worldwide-safe country lock for well-known travel destinations. free geocoder
  // occasionally returns a tiny Italian/US/UK locality first for short
  // names like "Cebu", "Maldives", "Manila" — which then poisons the trip
  // context with country='Italy' / 'United Kingdom'. When the LLM- or
  // geocode-derived country contradicts a known destination, prefer the
  // known one. This is a pure name → country map; no place hard-coding in
  // itinerary logic.
  const knownDestinationCountry = inferCountryForKnownDestination(
    merged.destinationName || u.destination || u.subArea || ""
  );
  // Reject region names like "South Asia" / "Southeast Asia" before they
  // settle as country.
  if (merged.country && isNonCountryRegion(merged.country)) {
    merged.country = "";
  }
  if (u.country && isNonCountryRegion(u.country)) {
    u.country = "";
  }
  if (knownDestinationCountry) {
    // Worldwide-safe: ALWAYS override the country when we know the
    // destination's true country from the protected map, UNLESS the user
    // typed a contradicting country explicitly (handled below by
    // extractExplicitCountryFromUserText). Without this, a fuzzy geocode
    // can stamp "China" / "United Kingdom" / "Italy" / "United States" on
    // a known-country destination like "Maldives", "Cebu", "Tokyo".
    if (!merged.country || knownDestinationCountry !== merged.country) {
      merged.country = knownDestinationCountry;
    }
  } else if (u.country && !merged.country) {
    merged.country = String(u.country).trim();
  }
  // User explicit country correction in their latest message ("its cebu
  // philippines", "in japan", "in spain") wins over any prior guess.
  const explicitCountryFromUser = extractExplicitCountryFromUserText(latestUserText);
  if (explicitCountryFromUser) merged.country = explicitCountryFromUser;
  if (typeof u.days === "number" && u.days > 0 && (!merged.days || merged.days <= 0)) {
    merged.days = u.days;
    merged.duration = true;
  }
  if (u.date && isReasonableShortFieldValue(u.date, "date")) {
    // Prefer a full ISO/explicit date from the latest user message over any
    // looser pre-existing value ("may 19" → "2027-05-19" on rollover, or a
    // freshly-confirmed start date overriding an earlier guess).
    const incomingIsIso = /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(u.date).trim());
    const existingIsIso = /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(merged.date || "").trim());
    if (!merged.date || (incomingIsIso && !existingIsIso) || (incomingIsIso && existingIsIso && u.date !== merged.date && latestUserExplicitlyMentionsDate(latestUserText))) {
      merged.date = String(u.date).trim();
    }
  }
  // Apply year-only / month+year correction. If the user said "may 2027" or
  // "make it 2027" without a day, preserve the existing day + month from the
  // current trip date and just swap the year (and month, if provided).
  if (Number.isFinite(u.dateYearOverride)) {
    const existing = String(merged.date || "").trim();
    const iso = existing.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const monthDay = existing.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*\d{4})?$/i);
    const monthOverride = Number.isFinite(u.dateMonthOverride) ? Number(u.dateMonthOverride) : null;
    if (iso) {
      const yr = u.dateYearOverride;
      const month = monthOverride || Number(iso[2]);
      const day = Number(iso[3]);
      merged.date = `${String(yr).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    } else if (monthDay) {
      const existingMonthIdx = MONTH_INDEX[String(monthDay[1] || "").toLowerCase().replace(/\.$/, "")];
      const month = monthOverride || existingMonthIdx;
      const day = Number(monthDay[2]);
      if (month && Number.isFinite(day)) {
        merged.date = `${String(u.dateYearOverride).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }
  if (u.travelers && isReasonableShortFieldValue(u.travelers, "travelers") && (!merged.travelers || canApplyLockedField("travelers"))) {
    merged.travelers = normalizeTravelerValue(u.travelers) || String(u.travelers).trim();
    if (merged.locked?.travelers) merged.lockedValues.travelers = merged.travelers;
  }
  if (u.budget && isReasonableShortFieldValue(u.budget, "budget") && (!merged.budget || canApplyLockedField("budget"))) {
    merged.budget = String(u.budget).trim();
    if (merged.locked?.budget) merged.lockedValues.budget = merged.budget;
  }
  if (u.theme && (!merged.theme || canApplyLockedField("style"))) {
    merged.theme = String(u.theme).trim();
    merged.interests = true;
    if (merged.locked?.style) merged.lockedValues.style = merged.theme;
  }
  if (u.origin && isReasonableShortFieldValue(u.origin, "origin") && (!merged.origin || canApplyLockedField("origin"))) {
    merged.origin = String(u.origin).trim();
    if (merged.locked?.origin) merged.lockedValues.origin = merged.origin;
  }
  if (u.startTime && isReasonableShortFieldValue(u.startTime, "startTime") && (!merged.startTime || canApplyLockedField("startTime"))) {
    merged.startTime = String(u.startTime).trim();
    if (merged.locked?.startTime) merged.lockedValues.startTime = merged.startTime;
  }
  if (u.preTripTravel) merged.preTripTravel = String(u.preTripTravel).trim();
  if (u.overnightBase) merged.overnightBase = String(u.overnightBase).trim();
  if (u.itineraryStartDate) {
    merged.itineraryStartDate = String(u.itineraryStartDate).trim();
    if (!merged.date) merged.date = merged.itineraryStartDate;
  }
  if (u.itineraryStartTime) {
    merged.itineraryStartTime = String(u.itineraryStartTime).trim();
    if (!merged.startTime || canApplyLockedField("startTime")) {
      merged.startTime = merged.itineraryStartTime;
      if (merged.locked?.startTime) merged.lockedValues.startTime = merged.startTime;
    }
  }
  if (u.itineraryStartPoint) merged.itineraryStartPoint = String(u.itineraryStartPoint).trim();
  if (u.transportMode && !merged.transportMode) {
    merged.transportMode = String(u.transportMode).trim();
  }
  if (invalidUnderstandingBaseArea(u.baseArea)) {
    if (!merged.baseArea && canApplyLockedField("baseArea")) merged.baseStatus = "recommend";
  } else if (u.baseArea && (!merged.baseArea || canApplyLockedField("baseArea"))) {
    merged.baseArea = String(u.baseArea).trim();
    merged.baseStatus = "provided";
    if (merged.locked?.baseArea) merged.lockedValues.baseArea = merged.baseArea;
  }
  if (u.noHotelYet === true && !merged.baseArea && !merged.baseStatus && canApplyLockedField("baseArea")) {
    merged.baseStatus = "recommend";
  }

  if (Array.isArray(u.uncertainAbout) && merged.acceptedAssumptions instanceof Set) {
    for (const field of u.uncertainAbout) {
      const f = String(field || "").trim();
      if (f) merged.acceptedAssumptions.add(f);
    }
  }
  if (u.isBroadDestination === false && merged.acceptedAssumptions instanceof Set) {
    merged.acceptedAssumptions.add("broadArea");
  }
}

module.exports = {
  understandTripIntent,
  understandingEnabled,
  applyTripUnderstandingToMerged,
  extractDeterministicTripFieldsFromText,
  normalizeTravelerValue,
  inferCountryForKnownDestination,
  extractExplicitCountryFromUserText,
};
