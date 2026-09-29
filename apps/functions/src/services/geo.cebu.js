const CEBU_GAZETTEER = {
  BANTAYAN_ISLAND: ["Santa Fe", "Sta. Fe", "Bantayan", "Madridejos"],
  NORTH_CEBU_MAINLAND: [
    "Bogo",
    "Daanbantayan",
    "Medellin",
    "San Remigio",
    "Tabogon",
    "Borbon",
    "Sogod",
    "Catmon",
    "Carmen",
  ],
  METRO_CEBU: [
    "Cebu City",
    "Mandaue",
    "Lapu-Lapu",
    "Mactan",
    "Talisay",
    "Cordova",
    "Consolacion",
  ],
  SOUTH_CEBU: [
    "Carcar",
    "Sibonga",
    "Argao",
    "Dalaguete",
    "Oslob",
    "Boljoon",
    "Alcoy",
    "Santander",
    "Naga",
  ],
};

const KNOWN_OFF_REGION_STOPS_FOR_BANTAYAN = [
  "Basilica Minore del Santo Nino",
  "Magellan's Cross",
  "Fort San Pedro",
  "Sugbo Mercado",
  "Temple of Leah",
  "Sirao Garden",
  "Carbon Market",
  "Yap-Sandiego Ancestral House",
  "Casa Gorordo Museum",
  "Heritage of Cebu Monument",
  "Taoist Temple",
  "Cebu Metropolitan Cathedral",
];

function normalizeCebuGeoText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textContainsAnyCebuGazetteerItem(text = "", items = []) {
  const haystack = normalizeCebuGeoText(text);
  if (!haystack) return false;
  return items.some((item) => {
    const needle = normalizeCebuGeoText(item);
    return needle && new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(haystack);
  });
}

function detectCebuRegionForText(text = "") {
  const raw = String(text || "");
  if (!raw.trim()) return "";
  if (textContainsAnyCebuGazetteerItem(raw, CEBU_GAZETTEER.BANTAYAN_ISLAND)) return "BANTAYAN";
  if (textContainsAnyCebuGazetteerItem(raw, CEBU_GAZETTEER.NORTH_CEBU_MAINLAND)) return "NORTH_CEBU_MAINLAND";
  if (textContainsAnyCebuGazetteerItem(raw, CEBU_GAZETTEER.METRO_CEBU)) return "METRO_CEBU";
  if (textContainsAnyCebuGazetteerItem(raw, CEBU_GAZETTEER.SOUTH_CEBU)) return "SOUTH_CEBU";
  return "";
}

function isBantayanScopeText(text = "") {
  return detectCebuRegionForText(text) === "BANTAYAN";
}

module.exports = {
  CEBU_GAZETTEER,
  KNOWN_OFF_REGION_STOPS_FOR_BANTAYAN,
  detectCebuRegionForText,
  isBantayanScopeText,
};
