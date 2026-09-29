require("dotenv").config();

const express = require("express");
const cors = require("cors");

const healthRoutes = require("./routes/health.routes");
const chatRoutes = require("./routes/chat.routes");

const app = express();

// ✅ Allow both Vite (5173) and Expo Web (8081)
const corsOptions = {
  origin: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8081",
    "http://127.0.0.1:8081",
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));

// ✅ IMPORTANT: use SAME CORS options for preflight
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "1mb" }));

// ✅ routes
app.use("/health", healthRoutes); // GET /health
app.use("/v1", chatRoutes);       // POST /v1/chat

module.exports = app;
