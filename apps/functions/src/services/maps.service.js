
try {
  require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
} catch (_) {}










































function inferSourceStopCategory(label = "") {
  const value = String(label || "");
  if (/\b(?:garden|flower\s+farm|botanical)\b/i.test(value)) return "tourism.attraction";
  if (/\b(?:beach|sandbar|cove|shore|coast)\b/i.test(value)) return "beach";
  if (/\b(?:viewpoint|view\s+point|lookout|overlook|scenic\s+view|tops?)\b/i.test(value)) return "tourism.sights";
  if (/\b(?:restaurant|dinner|lunch|brunch|supper|eatery|grill|kitchen|bistro|food)\b/i.test(value)) return "catering.restaurant";
  if (/\b(?:cafe|coffee)\b/i.test(value)) return "catering.cafe";
  return "";
}

function isFoodSearchText(text = "", includedType = "") {
  const type = String(includedType || "").trim();
  if (type === "restaurant" || type === "cafe") return true;
  return /\b(?:dinner|lunch|brunch|supper|meal|restaurant|restaurants|cafe|cafes|coffee|coffee\s+shop|food|eat|eating|dine|dining)\b/i.test(
    String(text || "")
  );
}

function getFoodLockedIncludedType(text = "", includedType = "") {
  const type = String(includedType || "").trim();
  if (type === "restaurant" || type === "cafe") return type;
  const value = String(text || "");
  if (/\b(?:cafe|cafes|coffee|coffee\s+shop)\b/i.test(value)) return "cafe";
  if (/\b(?:dinner|lunch|brunch|supper|meal|restaurant|restaurants|food|eat|eating|dine|dining)\b/i.test(value)) return "restaurant";
  return "";
}

function categoryHaystack(place = {}) {
  return [
    place?.name,
    place?.primaryType,
    ...(Array.isArray(place?.types) ? place.types : []),
    ...(Array.isArray(place?.categories) ? place.categories : []),
  ]
    .map((part) => String(part || ""))
    .join(" ")
    .toLowerCase();
}

function placeMatchesFoodCategory(place = {}, foodType = "restaurant") {
  const haystack = categoryHaystack(place);
  const name = String(place?.name || "").toLowerCase();
  const forbidden =
    /\b(?:hardware|pawn|pawnshop|financial|finance|bank|atm|money\s*changer|remittance|laundry|dry\s*clean|store|retail|shop|office|government|plaza)\b/.test(haystack) ||
    /\b(?:hardware|pawn|m\s*lhuillier|lhuilier|palawan\s+pawnshop|cebuana\s+lhuilier|rd\s+pawnshop|western\s+union|moneygram|laundry|dry\s*clean)\b/.test(name);
  if (forbidden) return false;

  if (foodType === "cafe") {
    return /\b(?:cafe|coffee|tea|bakery|dessert|catering\.cafe)\b/.test(haystack) ||
      /\b(?:cafe|coffee|tea|bakery|dessert)\b/.test(name);
  }

  return /\b(?:restaurant|catering|food|eatery|diner|grill|kitchen|bistro|cafe|coffee|bakery|bar|pub|fast_food|fast food)\b/.test(haystack) ||
    /\b(?:restaurant|eatery|grill|kitchen|bistro|cafe|coffee|bakery|bar|diner|food)\b/.test(name);
}

function placeMatchesSourceCategory(place = {}, category = "") {
  const cat = String(category || "").trim();
  if (!cat) return true;
  const haystack = categoryHaystack(place);
  const name = String(place?.name || "").toLowerCase();

  if (cat === "tourism.attraction") {
    if (/\b(?:mall|shopping|commercial|hardware|pawn|financial|bank|laundry)\b/.test(haystack)) return false;
    return /\b(?:tourism|attraction|sights|garden|park|viewpoint|lookout|farm|flower|botanical)\b/.test(haystack) ||
      /\b(?:garden|park|viewpoint|lookout|farm|flower|botanical)\b/.test(name);
  }

  if (cat === "natural.beach" || cat === "beach") {
    if (/\b(?:mall|shopping|commercial|hardware|pawn|financial|bank|laundry)\b/.test(haystack)) return false;
    return /\b(?:beach|natural\.beach|sandbar|cove|coast|shore|bay)\b/.test(haystack) ||
      /\b(?:beach|sandbar|cove|coast|shore|bay)\b/.test(name);
  }

  if (cat === "tourism.sights") {
    if (/\b(?:mall|shopping|commercial|hardware|pawn|financial|bank|laundry)\b/.test(haystack)) return false;
    return /\b(?:tourism|sights|viewpoint|lookout|overlook|scenic|observation)\b/.test(haystack) ||
      /\b(?:viewpoint|lookout|overlook|scenic|observation|tops?)\b/.test(name);
  }

  if (cat === "catering.restaurant") return placeMatchesFoodCategory(place, "restaurant");
  if (cat === "catering.cafe") return placeMatchesFoodCategory(place, "cafe");

  return haystack.includes(cat.toLowerCase());
}



// Strip date/month/year/newline tokens out of an area string before
// it goes to the place-search provider. Without this, callers that join recent user
// messages can leak "May 10" or "2026" into the area, producing log
// lines like `area=palawan \n may` and weakening the geocode result.


async function geocodeArea(areaText = '', options = {}) {
  const query = String(areaText || '').trim();
  if (!query) return null;
  const results = await require('./freeProviders.service').nominatimSearch(query, 5);
  if (!results.length) return null;
  const normalizedQuery = normalizeTextForMatch(query);
  const place = [...results].sort((a,b) => (normalizeTextForMatch(b.name) === normalizedQuery ? 1 : 0) - (normalizeTextForMatch(a.name) === normalizedQuery ? 1 : 0))[0];
  const normalizedName = normalizeTextForMatch(place.name);
  const normalizedAddress = normalizeTextForMatch(place.address);
  const confidence = normalizedName === normalizedQuery ? 0.95 : normalizedAddress.includes(normalizedQuery) ? 0.8 : 0.55;
  return { ...place, lat: place.location.lat, lng: place.location.lng, formatted: place.address || place.name, confidence, resultType: place.resultType || '', radiusMeters: Number(options.radiusMeters) || 15000 };
}

async function searchAreaCandidates(areaText = '', options = {}) {
  const query = String(areaText || '').trim();
  if (!query) return { results: [], provider: 'nominatim' };
  const results = await require('./freeProviders.service').nominatimSearch(query, options.limit || 10);
  return { results, provider: 'nominatim' };
}



























































function looksLikePlacesQuery(text = "") {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\bconvenient store\b/g, "convenience store")
    .replace(/\b7\s*\/\s*11\b/g, "7-eleven")
    .replace(/\b7\s+11\b/g, "7-eleven");

  if (!t) return false;

  // Safety / advisory questions are NOT places queries, even when they
  // mention a location or a named landmark. Route them to normal LLM
  // advice instead of returning a list of nearby places.
  // Examples: "is it safe to swim at Cloud 9 today?", "is it dangerous
  // to walk around Poblacion at night?", "are the waves safe right now?"
  if (
    /\b(is it safe|is it dangerous|safe to (?:swim|walk|drive|go|visit|travel|hike|surf)|dangerous to (?:swim|walk|drive|go|visit|travel|hike|surf)|currents?\s+safe|waves?\s+safe|tsunami|typhoon|earthquake|weather warning)\b/i.test(t)
  ) {
    return false;
  }

  if (
    /\b(do you know my location|you know my location|can you see my location|can you access my location|am i sharing my location|where am i|where am i right now|what is my current location|what's my current location|my current location|my exact location|share my exact location|locate my exact location|access my location|use my location|allow location access)\b/i.test(
      t
    )
  ) {
    return false;
  }

  const asksDishInsteadOfPlace =
    /\b(not the restaurant|name of the food|name of the dish|what(?:'s| is)\s+the\s+must[- ]?try\s+(?:food|dish)|what(?:'s| is)\s+the\s+name\s+of\s+the\s+(?:food|dish)|must[- ]?try\s+local\s+(?:food|dish)|local\s+(?:food|dish)\s+famous|traditional\s+(?:food|dish)|signature\s+(?:food|dish))\b/i.test(
      t
    );

  if (asksDishInsteadOfPlace) {
    return false;
  }

  const asksWhyResultsLookWrong =
    /\b(why|how come)\b/.test(t) &&
    /\b(recommend|recommended|recommending|showed|showing|suggested|picked|other country|wrong country|exact location|my location)\b/.test(
      t
    );

  if (asksWhyResultsLookWrong) {
    return false;
  }

  const wantsNearby =
    /\b(near me|nearby|near|around|around here|around me|close to|close to me|from here|closest|nearest|walking distance|within walking distance|open nearby)\b/i.test(t);

  const wantsAreaAnchor =
    /\b(in|at)\s+[a-z0-9][a-z0-9&'’./ -]{1,80}\b/i.test(t);

  const wantsLive =
    /\b(open now|right now|currently open|open late|current hours|hours today|hours right now)\b/i.test(t);

  const wants24HoursLike =
    /\b(24\s*hours?|24-hour|24hr|24 hrs?|open 24 hours?|open 24\/7|24\/7)\b/i.test(t);

  const wantsRankingOrQuality =
    /\b(high rating|high ratings|highest rated|top rated|best rated|good rating|good ratings|good reviews|well reviewed|well-reviewed|most reviewed|top reviews|best reviews|popular|popular spots|best|top|must try|must-try|authentic|affordable|budget friendly|budget-friendly|cheap|cheaper|quiet|cozy|cosy|family friendly|family-friendly)\b/i.test(
      t
    );

  const wantsPlaceType =
    /\b(cafe|cafes|coffee|coffee shop|coffee shops|restaurant|restaurants|pizza|burger|ramen|sushi|bakery|bar|breakfast|fast food|convenience store|convenience stores|grocery|groceries|pharmacy|pharmacies|hotel|hotels|hostel|hostels|accommodation|accommodations|accomodation|accomodations|lodging|guesthouse|inn|resort|food|foods|food spot|food spots|eat|eating|dine|dining|chinese|italian|mexican|indian|thai|french|japanese|vietnamese|mediterranean|american|fusion|soul food)\b/i.test(
      t
    );

  const wantsBrand =
    /\b(mcdo|mcdonald'?s|jollibee|kfc|burger king|chowking|greenwich|red ribbon|goldilocks|starbucks|bo'?s coffee|dunkin'?|dunkin'? donuts|the coffee bean|coffee bean|7[- ]?eleven|7\/11|ministop)\b/i.test(
      t
    );

  const wantsFindVerb =
    /\b(find|suggest|show|recommend|recommendation|recommendations|what|which|give me|list|provide|only provide)\b/i.test(t);

  const wantsNamedPlaceQuery =
    wantsNearby &&
    /\b(find|show|recommend|give me|list|provide|only provide)\b/i.test(t) &&
    !/\b(weather|visa|packing|budget|cost|currency|exchange rate|safety|culture|etiquette)\b/i.test(t);

  const looksLikeShortCategoryQuery =
    /^(?:best\s+|top\s+|cheap\s+|affordable\s+|authentic\s+|high[- ]?rating\s+|highest[- ]?rated\s+|top[- ]?rated\s+|well[- ]?reviewed\s+|good\s+reviews\s+)?(?:cafe|cafes|coffee|coffee shop|coffee shops|restaurant|restaurants|hotel|hotels|hostel|hostels|bakery|bakeries|bar|bars|pharmacy|pharmacies|convenience store|convenience stores|foods?|chinese(?: foods?)?|italian(?: foods?)?|mexican(?: foods?)?|indian(?: foods?)?|thai(?: foods?)?|french(?: foods?)?|japanese(?: foods?)?|vietnamese(?: foods?)?|mediterranean(?: foods?)?|american(?: foods?)?|fusion(?: foods?)?|soul food)(?:\s+that\s+(?:has|have)\s+(?:high\s+rating|good\s+reviews))?$/.test(
      t
    );

  return Boolean(
    (wantsPlaceType && (wantsNearby || wantsAreaAnchor || wantsLive || wants24HoursLike || wantsFindVerb || wantsRankingOrQuality)) ||
    (wantsBrand && (wantsNearby || wantsAreaAnchor || wantsLive || wants24HoursLike || wantsFindVerb || wantsRankingOrQuality)) ||
    ((wantsLive || wants24HoursLike) && (wantsNearby || wantsAreaAnchor || wantsPlaceType || wantsBrand)) ||
    (wantsPlaceType && wantsRankingOrQuality) ||
    wantsNamedPlaceQuery ||
    looksLikeShortCategoryQuery
  );
}

function extractPlaceType(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .replace(/\bconvenient store\b/g, "convenience store")
    .replace(/\b7\s*\/\s*11\b/g, "7-eleven")
    .replace(/\b7\s+11\b/g, "7-eleven");

  const cuisinePatterns = [
    { pattern: /\bchinese\b/, keyword: "chinese" },
    { pattern: /\bitalian\b/, keyword: "italian" },
    { pattern: /\bmexican\b/, keyword: "mexican" },
    { pattern: /\bindian\b/, keyword: "indian" },
    { pattern: /\bthai\b/, keyword: "thai" },
    { pattern: /\bfrench\b/, keyword: "french" },
    { pattern: /\bjapanese\b/, keyword: "japanese" },
    { pattern: /\bvietnamese\b/, keyword: "vietnamese" },
    { pattern: /\bmediterranean\b/, keyword: "mediterranean" },
    { pattern: /\bamerican\b/, keyword: "american" },
    { pattern: /\bfusion\b/, keyword: "fusion" },
    { pattern: /\bsoul\s*food\b|\bsoul\b/, keyword: "soul food" },
  ];

  if (/\b(mcdo|mcdonald'?s)\b/.test(t)) {
    return { type: "restaurant", keyword: "mcdonalds" };
  }

  if (/\bjollibee\b/.test(t)) {
    return { type: "restaurant", keyword: "jollibee" };
  }

  if (/\bkfc\b/.test(t)) {
    return { type: "restaurant", keyword: "kfc" };
  }

  if (/\bburger king\b/.test(t)) {
    return { type: "restaurant", keyword: "burger king" };
  }

  if (/\bchowking\b/.test(t)) {
    return { type: "restaurant", keyword: "chowking" };
  }

  if (/\bgreenwich\b/.test(t)) {
    return { type: "restaurant", keyword: "greenwich" };
  }

  if (/\bred ribbon\b/.test(t)) {
    return { type: "restaurant", keyword: "red ribbon" };
  }

  if (/\bgoldilocks\b/.test(t)) {
    return { type: "restaurant", keyword: "goldilocks" };
  }

  if (/\b(starbucks|bo'?s coffee|dunkin'?|dunkin' donuts|the coffee bean|coffee bean|seattle'?s best)\b/.test(t)) {
    return { type: "cafe", keyword: RegExp.lastMatch.toLowerCase() };
  }

  if (/\b(7[- ]?eleven|ministop)\b/.test(t)) {
    return {
      type: "convenience_store",
      keyword: /ministop/.test(t) ? "ministop" : "7 eleven",
    };
  }

  if (/\b(coffee shop|coffee shops|cafe|cafes|coffee)\b/.test(t)) {
    return { type: "cafe", keyword: "" };
  }

  if (/\bpizza\b/.test(t)) {
    return { type: "restaurant", keyword: "pizza" };
  }

  if (/\bburger\b/.test(t)) {
    return { type: "restaurant", keyword: "burger" };
  }

  if (/\bramen\b/.test(t)) {
    return { type: "restaurant", keyword: "ramen" };
  }

  if (/\bsushi\b/.test(t)) {
    return { type: "restaurant", keyword: "sushi" };
  }

  for (const cuisine of cuisinePatterns) {
    if (cuisine.pattern.test(t)) {
      return { type: "restaurant", keyword: cuisine.keyword, cuisine: cuisine.keyword };
    }
  }

  if (/\bvegan\b/.test(t)) {
    return { type: "restaurant", keyword: "vegan" };
  }

  if (/\bfast food\b/.test(t)) {
    return { type: "restaurant", keyword: "fast food" };
  }

  if (/\bbakery\b/.test(t)) {
    return { type: "bakery", keyword: "" };
  }

  if (/\bbar\b/.test(t)) {
    return { type: "bar", keyword: "" };
  }

  if (/\bbreakfast\b/.test(t)) {
    return { type: "restaurant", keyword: "breakfast" };
  }

  if (/\b(dinner|lunch|brunch|supper|meal|eat|eating|dine|dining)\b/.test(t)) {
    return { type: "restaurant", keyword: "" };
  }

  if (/\b(convenience store|convenience stores)\b/.test(t)) {
    return { type: "convenience_store", keyword: "" };
  }

  if (/\b(pharmacy|pharmacies)\b/.test(t)) {
    return { type: "pharmacy", keyword: "" };
  }

  if (/\b(hostel|hostels)\b/.test(t)) {
    return { type: "hostel", keyword: "" };
  }

  if (/\b(hotel|hotels|accommodation|accomodation|lodging|guesthouse|inn|resort)\b/.test(t)) {
    return { type: "hotel", keyword: "" };
  }

  if (/\brestaurants?\b/.test(t)) {
    return { type: "restaurant", keyword: "" };
  }

  if (/\bfood\b/.test(t)) {
    return { type: "restaurant", keyword: "" };
  }

  // Unknown place type → empty type, empty keyword. Downstream:
  //   - placeMatchesRequestedType returns true for empty requestedType
  //     (see the planner validation path), so place-search results pass
  //     through unfiltered.
  //   - buildPlacesQueryFromContext and buildPlacesSearchLabel fall through
  //     to the generic label "places" when type is empty, producing sensible
  //     search text like "places near <area>".
  // Previously this returned { type: "restaurant", keyword: "" }, which
  // silently turned every non-food query (barbershops, laundromats,
  // bookstores, museums, gas stations, etc.) into a restaurant-only search.
  return { type: "", keyword: "" };
}

function isCuisineRestaurantKeyword(keyword = "") {
  return [
    "chinese",
    "italian",
    "mexican",
    "indian",
    "thai",
    "french",
    "japanese",
    "vietnamese",
    "mediterranean",
    "american",
    "fusion",
    "soul food",
  ].includes(String(keyword || "").trim().toLowerCase());
}

function normalizeAreaAlias(value = "") {
  const trimmed = String(value || "").trim();
  const key = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^lapu\s*2$/.test(key) || /^lapu\s+lapu(?:\s+city)?$/.test(key)) {
    return "Lapu-Lapu City";
  }
  return trimmed;
}

function hasTypedProximityAnchor(text = "") {
  const raw = String(text || "").trim();
  const match = raw.match(
    /\b(?:nearby|near|around|close\s+to|closest\s+to|nearest\s+to|nearest|closest)\s+(?!me\b|my\s+location\b|current\s+location\b|here\b)([\p{L}\p{N}][\p{L}\p{N}&'’./ -]{0,80})/iu
  );
  const candidate = normalizeAreaAlias(
    String(match?.[1] || "")
      .split(/[?!;]|\b(?:please|pls|plz|thanks?|thank you)\b/i)[0]
      .replace(/^(?:the|a|an)\s+/i, "")
      .replace(/\b(open now|open nearby|currently open|right now|open late|from here|nearest|closest)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.,:-]+$/, "")
  );
  if (!candidate) return false;
  if (["me", "here", "my location", "current location", "my current location"].includes(candidate.toLowerCase())) {
    return false;
  }
  return !/^(?:coffee|coffee shops?|cafes?|restaurants?|food|hotels?|hostels?|places?|branches?)$/i.test(candidate);
}

function requiresExactLocationQuery(text = "") {
  const raw = String(text || "");

  if (hasTypedProximityAnchor(raw)) {
    return false;
  }

  if (/\b(?:near me|nearby|around me|close to me|near my location|from here|open nearby|closest to me|nearest to me|use my current location|based on my location)\b/i.test(raw)) {
    return true;
  }

  if (/\bnearby\s*(?:[.?!,;:]|please|pls|plz)?\s*$/i.test(raw)) {
    return true;
  }

  return false;
}

function formatCuisineLabel(keyword = "") {
  const raw = String(keyword || "").trim().toLowerCase();
  if (!raw) return "";

  if (raw === "soul food") return "Soul food restaurants";
  return `${raw.charAt(0).toUpperCase()}${raw.slice(1)} restaurants`;
}

function buildPlaceSearchLabel(type = "", keyword = "") {
  const normalizedKeyword = String(keyword || "").trim().toLowerCase();

  if (type === "restaurant" && isCuisineRestaurantKeyword(normalizedKeyword)) {
    return formatCuisineLabel(normalizedKeyword);
  }

  if (type === "cafe") return keyword || "coffee shops";
  if (type === "restaurant") return keyword || "restaurants";
  if (type === "bakery") return "bakeries";
  if (type === "bar") return "bars";
  if (type === "convenience_store") return keyword || "convenience stores";
  if (type === "pharmacy") return "pharmacies";
  if (type === "hotel") return "hotels";
  if (type === "hostel") return "hostels";
  return "places";
}

function cuisineKeywordVariants(keyword = "") {
  const normalized = String(keyword || "").trim().toLowerCase();
  if (!normalized) return [];

  const variants = {
    chinese: ["chinese"],
    italian: ["italian"],
    mexican: ["mexican"],
    indian: ["indian"],
    thai: ["thai"],
    french: ["french"],
    japanese: ["japanese"],
    vietnamese: ["vietnamese"],
    mediterranean: ["mediterranean"],
    american: ["american"],
    fusion: ["fusion"],
    "soul food": ["soul food", "soul"],
  };

  return variants[normalized] || [normalized];
}

function placeMatchesCuisineKeyword(place = {}, keyword = "") {
  if (!isCuisineRestaurantKeyword(keyword)) return true;

  const haystack = [
    String(place?.name || ""),
    String(place?.address || ""),
    String(place?.primaryType || ""),
    ...(Array.isArray(place?.types) ? place.types : []),
  ]
    .join(" ")
    .toLowerCase();

  const variants = cuisineKeywordVariants(keyword);
  const matchedVariant = variants.find((variant) => {
    const escaped = String(variant || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return escaped ? new RegExp(`\\b${escaped}\\b`, "i").test(haystack) : false;
  });

  if (matchedVariant) return true;

  const genericRestaurantLike =
    /\brestaurant\b/i.test(String(place?.primaryType || "")) ||
    (Array.isArray(place?.types) && place.types.some((type) => /\brestaurant\b/i.test(String(type || ""))));

  if (!genericRestaurantLike) return false;

  return false;
}

function isCommandOnlyAreaCandidate(value = "") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return false;

  return (
    /^(yes|yeah|yep|yup|sure|ok|okay|please do|go ahead|do it|lets go|let's go|continue|continue please|sounds good|that works|that one|yes please|yes provide me|yes use it|yes allow it|yes use my location|yes access my location|yes allow location access)$/.test(normalized) ||
    /^(no|nope|nah|not now|skip|dont|don't|no thanks|pass|stop)$/.test(normalized) ||
    /^(how many can you add|how many more can you add|how many more|how many can you show|how many can you list|how many more can you show|how many additional options|how many additional places)$/.test(normalized) ||
    /^(show|give|list|recommend)\s+\d+(?:\s+more)?(?:\s+(?:options?|places?))?$/.test(normalized) ||
    /^\d+\s+more(?:\s+(?:options?|places?))?$/.test(normalized) ||
    /^(more|more please|another|another one|other options?|more options?|give me more|show me more|any other options?)$/.test(normalized) ||
    /^(closest|nearest|open now|currently open|open late|late|inside the area only|inside this area only|from here|cheapest|lowest price|best value)$/.test(normalized) ||
    /^(how do i get there|how can i get there|how to get there|route there|directions there)$/.test(normalized) ||
    /^(which|what|who|where|when|why|how)\s+(?:one|ones|is|are|branch|branches|place|places)\b/.test(normalized) ||
    /^(is|are|do|does|did|can|could|would|should)\b/.test(normalized) ||
    /^(tell me|show me|give me|provide me|check if|confirm if)\b/.test(normalized) ||
    /\b(near me|nearby|close to me|around me|from here)\b/.test(normalized) ||
    /\b(show at least \d+ branches?|at least \d+ branches?|tell me which one is the closest|which one is the closest|exact address|open 24 hours)\b/.test(normalized)
  );
}

function extractAreaHint(text = "") {
  let raw = String(text || "").trim();
  if (!raw) return "";

  // Bug 2 follow-up fix: rewrite "nearby <ProperNoun>" / "closest to <ProperNoun>" /
  // "close to <ProperNoun>" / "next to <ProperNoun>" / "beside <ProperNoun>" /
  // "right by <ProperNoun>" on the RAW input before any anchor matching, so the
  // existing `\bnear\s+(...)` anchor regex below picks them up. Without this,
  // "coffee shops nearby IT Park Cebu" never matches any anchor and falls
  // through to the bare-fallback path where the category guard rejects it,
  // causing extractAreaHint to return "" and place search to silently fall
  // back to device location coordinates.
  raw = raw
    .replace(/\bnearby\s+(?=[\p{L}\p{N}])/giu, "near ")
    .replace(/\bclosest\s+to\s+(?=[\p{L}\p{N}])/giu, "near ")
    .replace(/\bclose\s+to\s+(?=[\p{L}\p{N}])/giu, "near ")
    .replace(/\bright\s+by\s+(?=[\p{L}\p{N}])/giu, "near ")
    .replace(/\bnext\s+to\s+(?=[\p{L}\p{N}])/giu, "near ")
    .replace(/\bbeside\s+(?=[\p{L}\p{N}])/giu, "near ")
    // Collapse redundant chains produced by the rewrites above and by the
    // user themselves: "near in", "near at", "in near", "near near".
    .replace(/\b(?:near|in|at)\s+(?:in|at|near)\s+/gi, "near ");

  const cleanAreaCandidate = (value = "") =>
    normalizeAreaAlias(
      String(value || "")
        .replace(/\bconvenient store\b/gi, "convenience store")
        .replace(/\b7\s*\/\s*11\b/gi, "7-eleven")
        .replace(/\b7\s+11\b/gi, "7-eleven")
        .replace(/^(?:could|can|would)\s+you\s+(?:please\s+)?(?:check|confirm|tell\s+me|look\s+up)\s+(?:if|whether)\s+/i, "")
        .replace(/^(?:please\s+)?(?:check|confirm|tell\s+me|look\s+up)\s+(?:if|whether)\s+/i, "")
        .replace(/^(?:provide|give|show|tell)\s+me\s+(?:the\s+)?(?:place|places|branch|branches|location|locations)\s+(?:of|for)\s+/i, "")
        .replace(/^(?:how about|what about|maybe|try|now)\s+/i, "")
        .replace(/^(?:inside|within|outside)\s+/i, "")
        .replace(/\b(show at least \d+ branches?|show \d+ branches?|at least \d+ branches?|tell me which one is the closest|which one is the closest|exact address|with exact address|open 24 hours)\b/gi, "")
        .replace(/\s+only$/i, "")
        .replace(/\s+(?:that|which)\s+(?:are|is|were|was)\b.*$/i, "")
        .replace(/\s+(?:with|having)\b.*$/i, "")
        .replace(/\b(open 24 hours?|24-hour|24hr|24 hrs?|24\/7|open now|currently open|right now|open late|late night|late-night|walking distance|within walking distance|inside this area only|inside the area only|from here|nearest|closest)\b/gi, "")
        .replace(/\b(near me|around me|close to me)\b/gi, "")
      // Strip "nearby" only when it has NO anchor after it (so the bare-fallback
      // path can still run for "coffee shops nearby"). When an anchor follows
      // ("nearby IT Park Cebu", "nearby Marina Bay Sands"), rewrite "nearby" to
      // "near" so the anchor regexes below can match it as a normal anchor word.
        .replace(/\bnearby\s+(?=[\p{L}\p{N}])/giu, "near ")
        .replace(/\bnearby\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.,;-]+$/, "")
    );

  const isGenericLocationWord = (value = "") =>
    ["me", "near", "around", "close to", "nearest", "closest", "near me", "nearby", "here", "there", "near there", "over there", "my location", "current location", "the area", "this area", "area", "same area", "same place", "same location", "that area", "around there", "that place", "the same area", "the same place"].includes(
      String(value || "").trim().toLowerCase()
    );

  const isQuestionLikeFragment = (value = "") => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return false;

    return (
      /^(which|what|who|where|when|why|how)\b/.test(normalized) ||
      /^(is|are|do|does|did|can|could|would|should)\b/.test(normalized) ||
      /^(tell me|show me|give me|provide me|check if|confirm if)\b/.test(normalized)
    );
  };

  const isBrandLikeFragment = (value = "") =>
    /\b(mcdo|mcdonald'?s|jollibee|kfc|burger king|chowking|greenwich|red ribbon|goldilocks|starbucks|bo'?s coffee|dunkin'?|dunkin'? donuts|the coffee bean|coffee bean|7[- ]?eleven|7\/11|ministop)\b/i.test(
      String(value || "")
    );

  // Reject "I'm" / "Im" / "I am" as a place name. Users frequently type
  // "Im in Cebu City" (no apostrophe) or "I'm in Siargao"; if anchor
  // matching fails due to a typo, we must never let the pronoun itself
  // become the searched place (which produced bogus "I'm Kim Korean BBQ
  // Singapore" results in testing).
  const isSelfPronounFragment = (value = "") => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return false;
    const firstToken = normalized.split(/\s+/)[0] || "";
    return (
      normalized === "im" ||
      normalized === "i'm" ||
      normalized === "i am" ||
      firstToken === "im" ||
      firstToken === "i'm" ||
      /^i\s+am\b/.test(normalized)
    );
  };

  const isCategoryLikeFragment = (value = "") =>
    /\b(cafe|cafes|coffee|coffee shop|coffee shops|restaurant|restaurants|bakery|bakeries|bar|bars|hotel|hotels|hostel|hostels|pharmacy|pharmacies|convenience store|convenience stores|fast food|grocery|groceries|store|stores|food|foods|chinese|italian|mexican|indian|thai|french|japanese|vietnamese|mediterranean|american|fusion|soul food)\b/i.test(
      String(value || "")
    );

  const isGarbageAreaFragment = (value = "") => {
    // Normalize by stripping ASCII punctuation only. Previously this used
    // [^a-z0-9] which wiped every non-Latin character (CJK, Cyrillic, Arabic,
    // etc.), making "東京" or "Москва" normalize to "" and be flagged as
    // garbage. Now we collapse punctuation/whitespace but preserve letters
    // in every script.
    const normalized = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) return true;

    return (
      /^(hi|hello|hey|yo|okay|ok|now)$/.test(normalized) ||
      /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight)$/.test(normalized) ||
      /^(show|show more|show me more|more|more please|another|another one|other options|more options|\d+ more|show \d+|show me \d+|show \d+ more|show me \d+ more)$/.test(normalized)
    );
  };

  const parenthesized = raw.match(/\(([^()]{3,120})\)/);
  if (parenthesized) {
    const inside = cleanAreaCandidate(parenthesized[1]);
    if (
      inside &&
      !isGenericLocationWord(inside) &&
      !isCommandOnlyAreaCandidate(inside) &&
      !isQuestionLikeFragment(inside) &&
      !isBrandLikeFragment(inside) &&
      !isCategoryLikeFragment(inside) &&
      !isGarbageAreaFragment(inside)
    ) {
      return inside;
    }
  }

  // Mall phrases are filter constraints, not area names.
  if (
    /\b(?:inside|within)\s+(?:the|a|any)?\s*(?:mall|malls|shopping center|shopping centre|market)\b/i.test(raw) ||
    /\b(?:include\s+)?inside\s+(?:the|a|any)?\s*(?:mall|malls|shopping center|shopping centre|market)\b/i.test(raw) ||
    /\b(?:mall\s+only|only\s+inside\s+(?:the\s+)?malls?|inside\s+malls?\s+only|only\s+in\s+malls?)\b/i.test(raw) ||
    /\b(?:outside\s+malls?|not\s+in\s+malls?|standalone)\b/i.test(raw)
  ) {
    return "";
  }

  const insideOnlyMatch = raw.match(/\b(?:inside|within)\s+([A-Za-z][A-Za-z0-9&'’./ -]{1,80})\s+only\b/i);
  if (insideOnlyMatch) {
    const insideOnly = cleanAreaCandidate(insideOnlyMatch[1]);
    if (
      insideOnly &&
      !isGenericLocationWord(insideOnly) &&
      !isCommandOnlyAreaCandidate(insideOnly) &&
      !isQuestionLikeFragment(insideOnly) &&
      !isBrandLikeFragment(insideOnly) &&
      !isCategoryLikeFragment(insideOnly) &&
      !isGarbageAreaFragment(insideOnly)
    ) {
      return insideOnly;
    }
  }

  const outsideMatch = raw.match(/^(?:how about\s+|what about\s+)?outside\s+([A-Za-z][A-Za-z0-9&'’./ -]{1,80})/i);
  if (outsideMatch) {
    const outsideArea = cleanAreaCandidate(outsideMatch[1]);
    if (
      outsideArea &&
      !isGenericLocationWord(outsideArea) &&
      !isCommandOnlyAreaCandidate(outsideArea) &&
      !isQuestionLikeFragment(outsideArea) &&
      !isBrandLikeFragment(outsideArea) &&
      !isCategoryLikeFragment(outsideArea) &&
      !isGarbageAreaFragment(outsideArea)
    ) {
      return outsideArea;
    }
  }

  const hasExactLocationPhrase = requiresExactLocationQuery(raw);

  if (hasExactLocationPhrase) {
    return "";
  }

  // Place-shape guard. A candidate must look like a place name, not an
  // English stopword phrase ("the airport", "the mall"), a time expression
  // ("noon", "7pm"), a numeric instruction fragment ("least 5 options"),
  // or a currency/command token. Two modes:
  //
  //   strict=false (default, used for captures from "in/near/around/i'm in"):
  //     allow lowercase Latin multi-word candidates like "ho chi minh".
  //
  //   strict=true (used for the bare-fallback path when no anchor matched):
  //     require the first token to be uppercase Latin or non-Latin script.
  //     This prevents the bare-fallback from accepting English sentences
  //     like "near the airport", "pay at the counter", "meet at 7pm" as
  //     fake area names just because their first word happens to be a
  //     lowercase alpha token.
  const looksLikePlaceShapedFragment = (value = "", strict = false) => {
    const cleaned = String(value || "").trim();
    if (!cleaned) return false;

    // First-token guard: reject determiner-led fragments like "the airport".
    if (/^(?:the|a|an|this|that|these|those|my|our|your|some|any|every)\b/i.test(cleaned)) {
      return false;
    }

    // Reject fragments that are purely numbers, times, or numeric instructions.
    if (/^\d/.test(cleaned)) return false;
    if (/^(?:noon|midnight|morning|afternoon|evening|night|tonight|today|tomorrow|yesterday|now|later|soon)\b/i.test(cleaned)) return false;

    // Reject time-of-day patterns and common English verbs/prepositions
    // that appear at the start of non-place sentences.
    if (/\b\d{1,2}\s*(?:am|pm)\b/i.test(cleaned)) return false;
    if (/^(?:pay|meet|eat|drink|sleep|wait|sit|stand|look|find|book|call|ask|near|around|at|on|to|from|by|for|with|without)\s+/i.test(cleaned)) return false;

    // Reject currency/command/instruction fragments.
    if (/\b(php|peso|pesos|usd|dollar|dollars|eur|euro|euros|sgd|jpy|yen|krw|won|thb|baht|currency|exchange rate)\b/i.test(cleaned)) return false;
    if (/^(?:use|with|make it|show|give me|change to|switch to|least|most|only|just|about|around|approximately)\b/i.test(cleaned)) return false;

    // Require the first token to look like a proper-noun in any script.
    const firstToken = cleaned.split(/\s+/)[0] || "";
    if (!firstToken) return false;

    // Latin uppercase start → likely proper noun. Accept in both modes.
    if (/^[A-Z]/.test(firstToken)) return true;

    // Any non-Latin letter start → likely proper noun in another script
    // (CJK / Cyrillic / Arabic / Devanagari / Thai / Hebrew / etc.).
    // Accept in both modes.
    if (/^[^\x00-\x7F]/u.test(firstToken) && /^\p{L}/u.test(firstToken)) return true;

    // Lowercase Latin start:
    //   - In non-strict mode (captures from explicit anchors), allow
    //     alpha-only tokens ≥3 chars. Users frequently type "tokyo" or
    //     "ho chi minh" in lowercase inside an explicit "in/near <X>" phrase.
    //   - In strict mode (bare-fallback), require the ENTIRE input to be
    //     a single lowercase alpha token ≥3 chars. Multi-word lowercase
    //     inputs are rejected to avoid accepting English sentences.
    if (/^[a-z][a-z'’-]{2,}$/.test(firstToken)) {
      if (strict) {
        // Bare-fallback: only single-word lowercase inputs allowed.
        return cleaned.split(/\s+/).length === 1;
      }
      return true;
    }

    return false;
  };

  // Anchor captures must STOP at sentence boundaries (. ? ! , ;) so that
  // messages like "Im in Cebu Citee. Wat coffeh shops are open neer mee"
  // capture only "Cebu Citee" and not the entire trailing sentence. We
  // also drop `.` and `/` from the allowed character class for the same
  // reason — they were letting captures run across sentences.
  const selfLocationMatch =
    raw.match(/\b(?:i am|i'm|im)\s+(?:in|at|near)\s+([\p{L}][\p{L}\p{N}&'’\- ]{1,60})(?=[.?!,;]|\s+(?:right\s+now|now|today|tonight|currently)\b|$)/iu) ||
    raw.match(/\b(?:i am|i'm|im)\s+(?:in|at|near)\s+([\p{L}][\p{L}\p{N}&'’\- ]{1,60})/iu);

  // Match "near/around <X>" and "in <X>" as location anchors. "at <X>" is
  // deliberately excluded because it over-captures English stopword phrases
  // like "at the airport", "at noon", "at least 5 options" — very few of
  // these are actual place references, and the place-shape guard below
  // would reject them anyway, so we save the regex work.
  //
  // "in <X>" IS matched (this is the most common English place-naming
  // pattern: "coffee shops in Tokyo", "restaurants in Lisbon"). Earlier
  // concerns about phrases like "in the philippines" or "in usd" are
  // handled by looksLikePlaceShapedFragment below, not by refusing the
  // match entirely.
  const m = selfLocationMatch ||
    raw.match(/\bnear\s+([\p{L}][\p{L}\p{N}&'’\- ]{1,60})(?=[.?!,;]|$)/iu) ||
    raw.match(/\bnear\s+([\p{L}][\p{L}\p{N}&'’\- ]{1,60})/iu) ||
    raw.match(/\baround\s+([\p{L}][\p{L}\p{N}&'’\- ]{1,60})(?=[.?!,;]|$)/iu) ||
    raw.match(/\baround\s+([\p{L}][\p{L}\p{N}&'’\- ]{1,60})/iu) ||
    raw.match(/\bin\s+([\p{L}][\p{L}\p{N}&'’\- ]{1,60})(?=[.?!,;]|$)/iu) ||
    raw.match(/\bin\s+([\p{L}][\p{L}\p{N}&'’\- ]{1,60})/iu);

  const candidateRaw = cleanAreaCandidate(m ? m[1] : "");
  const candidate = candidateRaw
    .replace(/\s+not\s+in\s+[\p{L}][\p{L}\p{N}&'’./ -]*/iu, "")
    .replace(/\s+/g, " ")
    .trim();

  if (
    candidate &&
    !isGenericLocationWord(candidate) &&
    !isCommandOnlyAreaCandidate(candidate) &&
    !isQuestionLikeFragment(candidate) &&
    !isBrandLikeFragment(candidate) &&
    !isCategoryLikeFragment(candidate) &&
    !isGarbageAreaFragment(candidate) &&
    !isSelfPronounFragment(candidate) &&
    looksLikePlaceShapedFragment(candidate)
  ) {
    return candidate;
  }

  // Bare-fallback path: the message has no explicit location anchor
  // ("in/near/around/i'm in"). We used to return the whole cleaned sentence
  // here if it was 1–6 words, which turned instructions and time phrases
  // into fake area names ("meet at 7pm", "at least 5 options" → returned
  // verbatim). Now we ONLY return a bare candidate if it ALSO passes the
  // place-shape guard — i.e. it starts with a proper-noun-shaped token in
  // any script and isn't a stopword/time/instruction fragment.
  const bare = cleanAreaCandidate(raw);
  if (!bare) return "";
  if (isGenericLocationWord(bare)) return "";
  if (isCommandOnlyAreaCandidate(bare)) return "";
  if (isQuestionLikeFragment(bare)) return "";
  if (isBrandLikeFragment(bare)) return "";
  if (isCategoryLikeFragment(bare)) return "";
  if (isGarbageAreaFragment(bare)) return "";
  if (isSelfPronounFragment(bare)) return "";
  if (/\b(open now|open late|24 hours|24\/7)\b/i.test(bare)) {
    return "";
  }
  if (/\b(how many|yes|yeah|yep|yup|sure|ok|okay|continue|go ahead|do it|add)\b/i.test(bare)) {
    return "";
  }
  if (/\b(best time|when to|what to|how to|should i|can i|do i|is it|are there|what is|what's|where to|convert|calculate)\b/i.test(bare)) {
    return "";
  }
  if (/\b(help me|help us|teach me|tell me|show me|give me|explain|write|solve|fix|make me|send me|remind me|assignment|homework|math|programming|code|coding)\b/i.test(bare)) {
    return "";
  }

  // Reject short messages that look like instructions or filter overrides
  // ("use php", "use peso not usd", "in usd", "show more", "make it cheaper").
  // These are NOT area names — returning them as areas causes place search
  // to search for nonsense locations like "near use php".
  if (/^(use|in|with|make it|show|give me|now|change to|switch to)\b/i.test(bare)) {
    return "";
  }
  if (/\b(php|peso|pesos|usd|dollar|dollars|eur|euro|euros|sgd|jpy|yen|currency|exchange rate)\b/i.test(bare)) {
    return "";
  }

  const wordCount = bare.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 1 && wordCount <= 6 && looksLikePlaceShapedFragment(bare, /* strict */ true)) {
    return bare;
  }

  return "";
}

function dedupeNearArea(text = "", areaHint = "") {
  const raw = String(text || "").trim();
  const area = String(areaHint || "").trim();

  if (!raw || !area) return raw;

  const escapedArea = area.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw
    .replace(new RegExp(`\\bnear\\s+${escapedArea}\\s+near\\s+${escapedArea}\\b`, "ig"), `near ${area}`)
    .replace(/\s+/g, " ")
    .trim();
}

function buildTextQuery(text = "") {
  const original = String(text || "").trim();
  const { type, keyword } = extractPlaceType(original);
  const areaHint = extractAreaHint(original);
  const wants24h = wants24Hours(original);
  const wantsLate = wantsOpenLate(original);
  const prefersInArea =
    /\bin\s+[A-Za-z0-9]/i.test(original) &&
    !/\b(near|near me|nearby|around|around me|close to|closest|nearest|from here)\b/i.test(original);

  const searchLabel = buildPlaceSearchLabel(type, keyword);
  const cuisineBoost =
    type === "restaurant" && isCuisineRestaurantKeyword(keyword)
      ? `${keyword} cuisine`
      : "";

  if (areaHint) {
    const areaConnector = prefersInArea ? "in" : "near";

    if (wants24h) {
      return [searchLabel, cuisineBoost, "open 24 hours", areaConnector, areaHint].filter(Boolean).join(" ");
    }

    if (wantsLate) {
      return [searchLabel, cuisineBoost, "open late", areaConnector, areaHint].filter(Boolean).join(" ");
    }

    return [searchLabel, cuisineBoost, areaConnector, areaHint].filter(Boolean).join(" ");
  }

  if (wants24h) return [searchLabel, cuisineBoost, "open 24 hours"].filter(Boolean).join(" ");
  if (wantsLate) return [searchLabel, cuisineBoost, "open late"].filter(Boolean).join(" ");

  return original;
}

function wants24Hours(text = "") {
  return /\b(24\s*hours?|24-hour|24hr|24 hrs?|open 24 hours?|open 24\/7|24\/7)\b/i.test(
    String(text || "")
  );
}

function wantsOpenLate(text = "") {
  return /\b(open late|late night|late-night)\b/i.test(String(text || ""));
}

function wantsOpenNow(text = "") {
  const raw = String(text || "");
  if (wants24Hours(raw) || wantsOpenLate(raw)) return false;

  const normalized = raw.toLowerCase();
  const hasPresenceOnlyPhrase =
    /\b(i am here right now|i'm here right now|im here right now|i am here now|i'm here now|im here now)\b/i.test(normalized) &&
    !/\b(open now|currently open|open right now|is it open now|are they open now|still open)\b/i.test(normalized);

  if (hasPresenceOnlyPhrase) return false;
  return /\b(open now|right now|currently open)\b/i.test(normalized);
}

function wantsCurrentHours(text = "") {
  return /\b(current hours|hours today|hours right now|today's hours|todays hours)\b/i.test(String(text || ""));
}



const PRICE_BRACKETS_BY_CURRENCY = {
  PHP: { symbol: "₱", brackets: ["₱1–200", "₱200–400", "₱400–800", "₱800+"] },
  JPY: { symbol: "¥", brackets: ["¥1–500", "¥500–1500", "¥1500–4000", "¥4000+"] },
  THB: { symbol: "฿", brackets: ["฿1–100", "฿100–300", "฿300–800", "฿800+"] },
  KRW: { symbol: "₩", brackets: ["₩1–5000", "₩5000–15000", "₩15000–40000", "₩40000+"] },
  IDR: { symbol: "Rp", brackets: ["Rp1–30k", "Rp30–80k", "Rp80–200k", "Rp200k+"] },
  SGD: { symbol: "S$", brackets: ["S$1–10", "S$10–25", "S$25–60", "S$60+"] },
  USD: { symbol: "$", brackets: ["$1–10", "$10–25", "$25–60", "$60+"] },
  EUR: { symbol: "€", brackets: ["€1–10", "€10–25", "€25–60", "€60+"] },
  GBP: { symbol: "£", brackets: ["£1–10", "£10–25", "£25–50", "£50+"] },
  TWD: { symbol: "NT$", brackets: ["NT$1–100", "NT$100–300", "NT$300–800", "NT$800+"] },
  HKD: { symbol: "HK$", brackets: ["HK$1–50", "HK$50–150", "HK$150–400", "HK$400+"] },
  MYR: { symbol: "RM", brackets: ["RM1–15", "RM15–40", "RM40–100", "RM100+"] },
  VND: { symbol: "₫", brackets: ["₫1–50k", "₫50–150k", "₫150–400k", "₫400k+"] },
  AUD: { symbol: "A$", brackets: ["A$1–15", "A$15–35", "A$35–80", "A$80+"] },
  NZD: { symbol: "NZ$", brackets: ["NZ$1–15", "NZ$15–35", "NZ$35–80", "NZ$80+"] },
  AED: { symbol: "AED", brackets: ["AED 1–30", "AED 30–80", "AED 80–200", "AED 200+"] },
  INR: { symbol: "₹", brackets: ["₹1–200", "₹200–500", "₹500–1500", "₹1500+"] },
  CAD: { symbol: "C$", brackets: ["C$1–15", "C$15–30", "C$30–60", "C$60+"] },
  MXN: { symbol: "MX$", brackets: ["MX$1–100", "MX$100–250", "MX$250–500", "MX$500+"] },
  COP: { symbol: "COL$", brackets: ["COL$1–15k", "COL$15–35k", "COL$35–80k", "COL$80k+"] },
  PEN: { symbol: "S/", brackets: ["S/1–20", "S/20–50", "S/50–100", "S/100+"] },
};

const COUNTRY_TO_CURRENCY = {
  Philippines: "PHP", Japan: "JPY", Thailand: "THB", "South Korea": "KRW",
  Indonesia: "IDR", Singapore: "SGD", "United States": "USD", "United Kingdom": "GBP",
  France: "EUR", Germany: "EUR", Italy: "EUR", Spain: "EUR", Netherlands: "EUR",
  Portugal: "EUR", Greece: "EUR", Austria: "EUR", Ireland: "EUR", Belgium: "EUR",
  Finland: "EUR", Taiwan: "TWD", "Hong Kong": "HKD", Malaysia: "MYR",
  Vietnam: "VND", Australia: "AUD", "New Zealand": "NZD",
  "United Arab Emirates": "AED", India: "INR",
  // Cambodia's tourism economy quotes in USD in practice (Siem Reap,
  // Phnom Penh, Angkor). KHR exists but is rarely used for tourist-facing
  // prices, so USD is the honest mapping here.
  Cambodia: "USD",
  Mexico: "MXN", Canada: "CAD", Colombia: "COP", Peru: "PEN",
};



// Neutral symbolic-tier fallback when the currency is unknown. Follows the
// same $/$$/$$$/$$$$ convention used by map listings. Previously this function
// fell back to PRICE_BRACKETS_BY_CURRENCY.PHP when the currency was unknown,
// which displayed "₱400–800" for places in Germany, Brazil, Iceland, etc.
const SYMBOLIC_PRICE_TIERS = ["$", "$$", "$$$", "$$$$"];









function isLikely24HourPlace(place = {}) {
  return /(?:^|;)\s*(?:Mo-Su|Mo-Sa|24\/7)\s+(?:00:00-24:00|00:00-23:59)(?:;|$)/i.test(String(place.openingHours || ''));
}





/**
 * Extracts the best available price range from a Places API v1 place object.
 *
 * Priority:
 *   1. place.priceRange object (startPrice/endPrice with real currency amounts)
 *   2. place.priceLevel enum string → hardcoded bracket mapping
 *   3. "Price not available"
 *
 * The Places API v1 returns priceRange as:
 *   { startPrice: { currencyCode, units, nanos }, endPrice: { currencyCode, units, nanos } }
 */







function formatStructuredPlaceStatus() { return 'Current operating status is unavailable.'; }

function formatWeeklyHoursSummary(place = {}) {
  const hours = String(place.openingHours || '').trim();
  return hours ? 'Listed hours: ' + hours + '; current open/closed status is unavailable.' : 'Opening hours unavailable.';
}

















































async function lookupSpecificPlaceStatus(requestedName = '', options = {}) {
  const target = String(requestedName || '').trim();
  if (!target) return null;
  const query = [target, String(options.areaHint || '').trim()].filter(Boolean).join(', ');
  const places = await searchTextPlaces(query, { maxResultCount: options.maxResultCount || 8 });
  const normalizedTarget = normalizeTextForMatch(target);
  const place = places.find((item) => normalizeTextForMatch(item.name) === normalizedTarget) || places[0] || null;
  return { place, status: 'unknown', reply: place ? 'I found ' + place.name + ', but live operating status and opening hours are unavailable.' : 'I could not verify a place match for ' + target + '; operating status and hours are unknown.' };
}

async function lookupPlaceBranches(requestedName = '', options = {}) {
  const target = String(requestedName || '').trim();
  if (!target) return null;
  const areaHint = String(options.areaHint || '').trim();
  const query = [target, areaHint].filter(Boolean).join(', ');
  const places = await searchTextPlaces(query, { maxResultCount: Math.min(Number(options.displayCount) || 6, 10) });
  const names = places.map((place) => place.name).filter(Boolean);
  return { places, count: places.length, reply: places.length ? 'Places matching ' + target + (areaHint ? ' near ' + areaHint : '') + ': ' + names.join('; ') + '. Ratings and hours are unavailable.' : 'I could not find matching places for ' + target + (areaHint ? ' near ' + areaHint : '') + '.' };
}



async function searchTextPlaces(userText, options = {}) {
  const originalText = String(userText || '').trim();
  if (!originalText) return [];
  const query = String(options.textQuery || buildTextQuery(originalText)).trim();
  if (!query) return [];
  const center = options.locationBias || options.locationRestriction || options.center || null;
  const places = await require('./freeProviders.service').photonSearch(query, { lat: Number(center?.lat ?? center?.latitude), lon: Number(center?.lng ?? center?.longitude), limit: options.maxResultCount });
  return places.map((place) => ({ ...place, rating: null, userRatingCount: null, reviews: null, openNow: null, openingHours: null, weekdayDescriptions: [], isOperational: null, priceRange: null, priceLevel: null, provider: 'photon' }));
}

async function searchTextPlacesAcrossProviders(userText, options = {}) {
  const results = await searchTextPlaces(userText, options);
  const query = String(options.textQuery || buildTextQuery(userText)).trim();
  return { results, providers: [{ provider: 'photon', query, resultCount: results.length, fallbackReason: '' }], fallbackReason: results.length ? '' : 'photon_empty' };
}

async function searchPlaceCandidates(userText, options = {}) {
  const results = await searchTextPlaces(userText, options);
  return { results, fallbackReason: results.length ? '' : 'photon_empty' };
}


function formatPlacesResultsTable(results = [], originalUserText = '', maxDisplayCount = 5) {
  if (!Array.isArray(results) || !results.length) return '';
  const timingRequested = wants24Hours(originalUserText) || wantsOpenLate(originalUserText) || wantsOpenNow(originalUserText);
  const lines = results.slice(0, maxDisplayCount).map((place) => String(place.name || 'Unnamed place') + ' | ' + (place.address || 'Address unavailable') + ' | Rating: unknown | Hours: unknown');
  const note = timingRequested ? 'Live opening status is unavailable from this place data.' : 'Ratings and opening hours are unavailable unless explicitly listed.';
  return 'Places found:\n\n' + lines.join('\n') + '\n\n' + note;
}

async function reverseGeocodeLabel(lat, lng) {
  const result = await require('./freeProviders.service').reverseGeocode(lat, lng);
  const address = String(result?.address || '').trim();
  return address ? { label: address.split(',').slice(0, 3).join(', '), formattedAddress: address } : null;
}

async function resolvePlaceAnchor(anchorText = '', options = {}) {
  const raw = String(anchorText || '').trim();
  if (!raw) return null;
  const place = (await require('./freeProviders.service').nominatimSearch(raw, 1))[0];
  if (!place?.location) return null;
  return { lat: place.location.lat, lng: place.location.lng, label: place.name, address: place.address, anchorText: raw, placeId: place.id, country: place.country || null, countryCode: place.countryCode || options.regionCode || null };
}

function normalizeTextForMatch(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAddressParts(place = {}) {
  const parts = String(place?.address || "")
    .split(",")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const country = String(place?.country || "").trim() ||
    (parts.length ? String(parts[parts.length - 1] || "").trim() : "");
  const city = String(place?.city || "").trim() ||
    (parts.length >= 2 ? String(parts[parts.length - 2] || "").trim() : "");
  return { parts, city, country };
}

function countriesLikelyEquivalentForRegion(anchorCountry = "", placeCountry = "") {
  const a = normalizeTextForMatch(anchorCountry);
  const b = normalizeTextForMatch(placeCountry);
  if (!a || !b) return false;
  if (a === b) return true;
  const aliases = {
    japan: ["jp", "jpn", "nihon", "nippon"],
    jp: ["japan"],
    philippines: ["ph", "phl", "republic of the philippines"],
    ph: ["philippines"],
    "united states": ["us", "usa", "united states of america"],
    us: ["united states", "united states of america", "usa"],
    usa: ["united states", "united states of america", "us"],
    "united kingdom": ["uk", "gb", "great britain", "england"],
    uk: ["united kingdom", "great britain", "gb"],
    gb: ["united kingdom", "great britain", "uk"],
  };
  return (aliases[a] || []).includes(b) || (aliases[b] || []).includes(a);
}

function placeMatchesAnchorRegion(place = {}, anchorText = "") {
  const rawAnchor = String(anchorText || "").trim();
  if (!rawAnchor) return true;

  const anchorParts = rawAnchor
    .split(",")
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  if (!anchorParts.length) return true;

  const { parts: addressParts, city, country } = extractAddressParts(place);
  const normalizedAddress = normalizeTextForMatch(addressParts.join(", "));
  const normalizedCity = normalizeTextForMatch(city);
  const normalizedCountry = normalizeTextForMatch(country);
  const normalizedName = normalizeTextForMatch(place?.name || place?.resolvedName || place?.label || "");
  const searchableRegionText = [normalizedName, normalizedAddress, normalizedCity, normalizedCountry]
    .filter(Boolean)
    .join(" ");

  const anchorCountry = normalizeTextForMatch(anchorParts[anchorParts.length - 1] || "");
  const anchorRegion = normalizeTextForMatch(
    anchorParts.length >= 2 ? anchorParts[anchorParts.length - 2] : anchorParts[0]
  );

  if (
    anchorCountry &&
    normalizedCountry &&
    anchorCountry !== normalizedCountry &&
    !countriesLikelyEquivalentForRegion(anchorCountry, normalizedCountry)
  ) {
    return false;
  }

  const ANCHOR_STOPWORDS = new Set([
    "city", "prefecture", "province", "country", "region", "area", "destination",
    "and", "the", "for", "you", "are", "not", "but", "our", "out",
    "all", "any", "can", "has", "had", "was", "who", "how", "why",
  ]);

  const meaningfulAnchorTokens = anchorParts
    .flatMap((part) => normalizeTextForMatch(part).split(/\s+/))
    .filter(
      (token) =>
        token.length >= 3 &&
        !ANCHOR_STOPWORDS.has(token)
    );

  if (!meaningfulAnchorTokens.length) return true;

  const matchedTokens = meaningfulAnchorTokens.filter((token) =>
    searchableRegionText.includes(token)
  );

  if (anchorRegion && searchableRegionText.includes(anchorRegion)) {
    return true;
  }

  if (
    anchorRegion === "tokyo" &&
    /\b(?:shinjuku|shibuya|asakusa|ueno|yoyogi|harajuku|ginza|akihabara|taito|sumida|minato|chiyoda|meguro|setagaya|roppongi|ikebukuro|omoide|kabukicho)\b/i.test(searchableRegionText)
  ) {
    return true;
  }

  if (anchorRegion && normalizedCity && anchorRegion !== normalizedCity) {
    return matchedTokens.length >= Math.min(2, meaningfulAnchorTokens.length);
  }

  return matchedTokens.length >= Math.min(2, meaningfulAnchorTokens.length);
}

module.exports = {
  looksLikePlacesQuery, extractPlaceType, extractAreaHint, buildTextQuery,
  wants24Hours, wantsOpenNow, wantsOpenLate, wantsCurrentHours,
  searchTextPlaces, searchTextPlacesAcrossProviders, searchPlaceCandidates, searchAreaCandidates,
  formatPlacesResultsTable, lookupSpecificPlaceStatus, lookupPlaceBranches, reverseGeocodeLabel,
  geocodeArea, resolvePlaceAnchor, placeMatchesAnchorRegion,
  formatStructuredPlaceStatus, formatWeeklyHoursSummary, isLikely24HourPlace,
};
