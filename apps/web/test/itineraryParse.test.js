import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isDayHeader,
  itineraryStops,
  parseItinerary,
  parseLeg,
  placeKey,
  placeQuery,
  stopDays,
} from "../src/utils/itineraryParse.js";

const panagsama = readFileSync(new URL("./fixtures/panagsama.txt", import.meta.url), "utf8");
const header = [
  "Panagsama Beach • May 25–27",
  "Trip dates: 2026-05-25 to 2026-05-27",
  "Base: Moalboal • Style: time-based • Budget: mid-range",
  "",
].join("\n");

const countByDay = (stops) =>
  stopDays(stops).map((day) => stops.filter((s) => s.day === day).length);

test("multi-line fixture yields 5 / 5 / 4 stops numbered per day", () => {
  const stops = itineraryStops(header + panagsama);
  assert.deepEqual(countByDay(stops), [5, 5, 4]);
  for (const day of [1, 2, 3]) {
    const orders = stops.filter((s) => s.day === day).map((s) => s.order);
    assert.deepEqual(orders, orders.map((_, i) => i + 1));
  }
});

test("multi-line fixture keeps place, times and description apart", () => {
  const { headerLines, days } = parseItinerary(header + panagsama);
  assert.equal(headerLines.length, 3);
  assert.deepEqual(days.map((d) => d.day), [1, 2, 3]);
  assert.equal(days[0].title, "Day 1 — May 25");

  const first = days[0].activities[0];
  assert.equal(first.start, "07:00");
  assert.equal(first.end, "10:00");
  assert.equal(first.place, "Cebu City to Moalboal");
  assert.match(first.desc, /^Leave Cebu early/);
  assert.equal(days[1].activities[3].place, "Basdaku White Beach");
});

test("the same place on different days is kept on each day", () => {
  const stops = itineraryStops(panagsama);
  const panagsamaDays = stops.filter((s) => s.place === "Panagsama Beach").map((s) => s.day);
  assert.deepEqual(panagsamaDays, [1, 3]);
  assert.ok(stops.some((s) => s.day === 2 && s.place === "Moalboal Panagsama Beach"));
});

test("transfer legs are marked and geocode their destination", () => {
  const stops = itineraryStops(panagsama);
  const out = stops.find((s) => s.day === 1 && s.order === 1);
  assert.equal(out.isTransfer, true);
  assert.equal(out.query, "Moalboal");
  assert.equal(out.fromQuery, "Cebu City");

  const back = stops.find((s) => s.day === 3 && s.order === 4);
  assert.equal(back.isTransfer, true);
  assert.equal(back.query, "Cebu City");
  assert.equal(back.fromQuery, "Moalboal");

  assert.equal(stops.filter((s) => s.isTransfer).length, 2);
});

test("one-line format with Day headers still parses", () => {
  const text = [
    "Manila • Jun 1–2",
    "Trip dates: 2026-06-01 to 2026-06-02",
    "Day 1 — Jun 1",
    "09:00-11:00 - Fort Santiago - Walk the walls of Intramuros.",
    "11:30–13:00 - Manila Cathedral - Quick visit before lunch.",
    "Day 2 — Jun 2",
    "08:00–10:00 - Rizal Park - Morning stroll.",
    "",
    "---",
    "Estimated Budget Per Person",
    "Food: PHP 1,500",
    "Estimated total: PHP 6,000",
    "Would you like to save this itinerary?",
  ].join("\n");

  const parsed = parseItinerary(text);
  assert.equal(parsed.headerLines.length, 2);
  assert.deepEqual(parsed.days[0].activities[0], {
    start: "09:00",
    end: "11:00",
    place: "Fort Santiago",
    desc: "Walk the walls of Intramuros.",
  });
  assert.deepEqual(parsed.appendixLines, [
    "Estimated Budget Per Person",
    "Food: PHP 1,500",
    "Estimated total: PHP 6,000",
  ]);

  const stops = itineraryStops(parsed);
  assert.deepEqual(stops.map((s) => `${s.day}.${s.order} ${s.query}`), [
    "1.1 Fort Santiago",
    "1.2 Manila Cathedral",
    "2.1 Rizal Park",
  ]);
});

test("markdown bold, AM/PM times and embedded map JSON are handled", () => {
  const text = [
    "### Day 1 — Mar 3",
    "1. **9:00 AM–11:00 AM**",
    "**Kawasan Falls**",
    "Canyoneering optional.",
    "<<<MAP_STOPS_JSON>>>",
    '{"mapStops":[{"day":1,"order":1,"label":"Kawasan Falls"}]}',
    "<<<END_MAP_STOPS_JSON>>>",
  ].join("\n");

  const stops = itineraryStops(text);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].place, "Kawasan Falls");
  assert.equal(stops[0].start, "9:00 AM");
  assert.equal(stops[0].desc, "Canyoneering optional.");
});

test("timed lines without a Day header go to Day 1", () => {
  const stops = itineraryStops("Cebu • Jul 4\n10:00–12:00 - Magellan's Cross - Photos.");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].day, 1);
});

test("day header detection", () => {
  assert.ok(isDayHeader("Day 1 — May 25"));
  assert.ok(isDayHeader("## Day 12: Departure"));
  assert.ok(isDayHeader("**Day 3**"));
  assert.ok(!isDayHeader("Day 2 is a slow one"));
});

test("leg and query helpers", () => {
  assert.deepEqual(parseLeg("Travel from Cebu City to Moalboal"), { from: "Cebu City", to: "Moalboal" });
  assert.deepEqual(parseLeg("Return to Cebu City"), { from: null, to: "Cebu City" });
  assert.equal(parseLeg("Road to Hana"), null);
  assert.equal(parseLeg("Kumbira Restaurant & Bar"), null);
  assert.equal(placeQuery("Moalboal Sardine Run area"), "Moalboal Sardine Run");
  assert.equal(placeQuery("Fort Santiago (Intramuros)"), "Fort Santiago");
  assert.equal(placeKey("French Bakery Ô Délices"), "french bakery o delices");
});
