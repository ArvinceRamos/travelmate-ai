"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { previousAssistantAskedExactGenerateItineraryCta } = require("../src/services/llm.service");
const {
  appendBlueprintIfSetupCompletedAfterRecommendation,
  ensureTripSummaryHeading,
  latestUserIsComplaintOrMeta,
} = require("../src/services/intake.controller");
const { rateLimit } = require("../src/middleware/rateLimit");

const lastAssistant = (content) => [{ role: "user", content: "hi" }, { role: "assistant", content }];

test("a freely phrased generate question still counts as the generate CTA", () => {
  for (const question of [
    "Would you like me to generate your full itinerary now?",
    "Shall I turn this into the full itinerary?",
    "Want me to generate the full itinerary from this?",
    "Should I build the 3-day itinerary now?",
    "Ready to generate your itinerary?**",
  ]) {
    assert.equal(previousAssistantAskedExactGenerateItineraryCta(lastAssistant(`- **Destination:** Cebu\n\n${question}`)), true, question);
  }
  for (const question of [
    "Would you like to save this itinerary?",
    "Would you like me to make any changes to the itinerary?",
    "Which part of South Cebu do you want to focus on?",
  ]) {
    assert.equal(previousAssistantAskedExactGenerateItineraryCta(lastAssistant(question)), false, question);
  }
});

test("a blueprint without a heading gets the Trip summary heading the confirm gates look for", () => {
  const decision = {
    intent: "show_blueprint",
    replyText: "Great pick.\n\n- **Destination:** Tokyo\n- **Dates:** Nov 10–12\n\nWould you like me to generate your full itinerary now?",
  };
  const fixed = ensureTripSummaryHeading(decision);
  assert.match(fixed.replyText, /^Great pick\.\n\n\*\*Trip summary:\*\*\n\n- \*\*Destination:\*\* Tokyo/);
  assert.equal(ensureTripSummaryHeading(fixed), fixed);
  assert.equal(ensureTripSummaryHeading({ ...decision, intent: "update_context" }).replyText, decision.replyText);
});

test("'no special requests' answers the intake question instead of reading as a complaint", () => {
  assert.equal(latestUserIsComplaintOrMeta("9am, stay in Shinjuku, no special requests"), false);
  assert.equal(latestUserIsComplaintOrMeta("none, no special request"), false);
  assert.equal(latestUserIsComplaintOrMeta("why did you add that to my special requests?"), true);
  assert.equal(latestUserIsComplaintOrMeta("I didn't ask for an itinerary"), true);
});

test("a pre-generation hotel answer always ends with a next step", () => {
  const hotels = "### Manila\n\n- **Intramuros:** walkable history base.";
  const summary = "**Trip summary:**\n\n- **Destination:** Manila\n\nShall I turn this into the full itinerary?";
  const complete = {
    destination: "Manila", days: 3, date: "2026-10-20", travelers: "Solo", budget: "mid-range",
    origin: "Cebu", startTime: "08:00", transportMode: "flight + local transfer", noHotelYet: true, essentialsComplete: true,
  };

  const afterSummary = appendBlueprintIfSetupCompletedAfterRecommendation({
    normalizedParsed: { tripContext: { ...complete } },
    recent: [{ role: "user", content: "Manila trip" }, { role: "assistant", content: summary }, { role: "user", content: "recommend a base" }],
    latestUser: "recommend a base",
    sections: [hotels],
  });
  assert.equal(afterSummary[0], hotels);
  assert.equal(previousAssistantAskedExactGenerateItineraryCta(lastAssistant(afterSummary.join("\n\n---\n\n"))), true);

  const missingDate = appendBlueprintIfSetupCompletedAfterRecommendation({
    normalizedParsed: { tripContext: { ...complete, date: null, startTime: null, essentialsComplete: false } },
    recent: [{ role: "user", content: "Oct 20-22, solo, from Cebu, no hotel yet so recommend a base" }],
    latestUser: "Oct 20-22, solo, from Cebu, no hotel yet so recommend a base",
    sections: [hotels],
  });
  assert.equal(missingDate.length, 2);
  assert.doesNotMatch(missingDate[1], /date/i, "the date the user typed must not be asked again");
  assert.match(missingDate[1], /time/i);
});

test("stacked rate limiters each count a request once", () => {
  const first = rateLimit({ windowMs: 60_000, maxRequests: 2 });
  const second = rateLimit({ windowMs: 60_000, maxRequests: 2, keyByIp: true });
  const req = { ip: `203.0.113.${(process.pid % 200) + 1}`, socket: {} };
  let passed = 0;
  const res = () => ({ set() { return this; }, status() { return this; }, json() { return this; } });
  for (let i = 0; i < 2; i += 1) first(req, res(), () => second(req, res(), () => { passed += 1; }));
  assert.equal(passed, 2);
});

test("a past date the model chose for a year-less user date moves to next year", () => {
  const { rollPastTripDatesForward } = require("../src/services/intake.controller");
  const decision = {
    intent: "show_blueprint",
    tripContext: { date: "2026-05-25" },
    replyText: "**Trip summary:**\n\n- **Dates:** May 25–27, 2026\n- **Return:** December 1, 2026\n\nShall I turn this into the full itinerary?",
  };
  const rolled = rollPastTripDatesForward(decision, [{ role: "user", content: "May 25-27" }], "2026-10-15");
  assert.equal(rolled.tripContext.date, "2027-05-25");
  assert.match(rolled.replyText, /May 25–27, 2027/);
  assert.match(rolled.replyText, /December 1, 2026/);

  const typedYear = rollPastTripDatesForward(decision, [{ role: "user", content: "May 25-27, 2026" }], "2026-10-15");
  assert.equal(typedYear.tripContext.date, "2026-05-25");
});
