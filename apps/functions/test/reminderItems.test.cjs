"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { extractTimedItemsByDay } = require("../app");

const panagsama = fs.readFileSync(path.join(__dirname, "../../web/test/fixtures/panagsama.txt"), "utf8");

// Asia/Manila: getTimezoneOffset() === -480
const TZ = -480;
const at = (y, mo, d, h, min) => Date.UTC(y, mo - 1, d, h, min) + TZ * 60_000;
const countByDay = (items) => [1, 2, 3].map((day) => items.filter((i) => i.dayNum === day).length);

test("multi-line fixture yields 14 reminders, 5 / 5 / 4 per day", () => {
  const items = extractTimedItemsByDay(panagsama, "2026-05-25", TZ);
  assert.equal(items.length, 14);
  assert.deepEqual(countByDay(items), [5, 5, 4]);
});

test("multi-line reminders keep the output shape and land on the right local times", () => {
  const items = extractTimedItemsByDay(panagsama, "2026-05-25", TZ);
  assert.deepEqual(items[0], {
    whenMs: at(2026, 5, 25, 7, 0),
    timeLabel: "07:00",
    endLabel: "10:00",
    label: "Cebu City to Moalboal",
    dayNum: 1,
  });

  const day2 = items.find((i) => i.dayNum === 2);
  assert.equal(day2.whenMs, at(2026, 5, 26, 9, 30));
  assert.equal(day2.label, "Kawasan Falls");

  const last = items[items.length - 1];
  assert.equal(last.whenMs, at(2026, 5, 27, 11, 30));
  assert.equal(last.label, "Moalboal to Cebu City");

  const sorted = [...items].sort((a, b) => a.whenMs - b.whenMs);
  assert.deepEqual(items, sorted);
});

test("one-line format: separators, 12-hour times, bullets, bold and map JSON", () => {
  const text = [
    "Cebu City • 2 days",
    "",
    "Day 1 — Jun 1",
    "09:00–11:00 - Magellan's Cross - Start at the historic cross.",
    "- 1:00 PM - 2:30 PM: Larsian BBQ - Grilled lunch.",
    "",
    "## Day 2",
    "**08:00 to 09:00** Tops Lookout",
    "7:30 p.m.–9:00 p.m. - Sugbo Mercado",
    "<<<MAP_STOPS_JSON>>>",
    '{"stops":[{"time":"10:00–11:00","name":"Ignored"}]}',
    "<<<END_MAP_STOPS_JSON>>>",
  ].join("\n");

  const items = extractTimedItemsByDay(text, "2026-06-01", TZ);
  assert.deepEqual(
    items.map(({ whenMs, timeLabel, endLabel, label, dayNum }) => [whenMs, timeLabel, endLabel, label, dayNum]),
    [
      [at(2026, 6, 1, 9, 0), "09:00", "11:00", "Magellan's Cross", 1],
      [at(2026, 6, 1, 13, 0), "1:00 PM", "2:30 PM", "Larsian BBQ", 1],
      [at(2026, 6, 2, 8, 0), "08:00", "09:00", "Tops Lookout", 2],
      [at(2026, 6, 2, 19, 30), "7:30 p.m.", "9:00 p.m.", "Sugbo Mercado", 2],
    ]
  );
});

test("CRLF text parses the same as LF", () => {
  const crlf = panagsama.replace(/\r?\n/g, "\r\n");
  const lf = panagsama.replace(/\r\n/g, "\n");
  assert.deepEqual(extractTimedItemsByDay(crlf, "2026-05-25", TZ), extractTimedItemsByDay(lf, "2026-05-25", TZ));
});

test("no trip start date or no timed slots yields no reminders", () => {
  assert.deepEqual(extractTimedItemsByDay(panagsama, null, TZ), []);
  assert.deepEqual(extractTimedItemsByDay("Day 1\nMorning: Beach\nEvening: Dinner", "2026-05-25", TZ), []);
  assert.deepEqual(extractTimedItemsByDay("", "2026-05-25", TZ), []);
});
