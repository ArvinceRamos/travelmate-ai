"use strict";

if (process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIREBASE_EMULATOR_HUB) {
  const dotenv = require("dotenv");
  const envPath = require("path").join(__dirname, ".env");
  dotenv.config({ path: envPath });
  dotenv.config();
}

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const { app, runReminderSweep } = require("./app");

exports.api = onRequest(
  {
    region: "asia-southeast1",
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: ["GEMINI_API_KEY", "OPENAI_API_KEY"],
  },
  app
);

exports.reminderWorker = onSchedule(
  {
    schedule: "every 1 minutes",
    region: "asia-southeast1",
  },
  async () => {
    await runReminderSweep();
  }
);
