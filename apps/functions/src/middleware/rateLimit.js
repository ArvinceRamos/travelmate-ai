"use strict";

/**
 * Simple in-memory sliding-window rate limiter.
 * No external dependencies required.
 */

const buckets = new Map();

// Evict stale entries every 5 minutes to prevent memory growth.
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, timestamps] of buckets) {
    const fresh = timestamps.filter((t) => t > cutoff);
    if (fresh.length === 0) buckets.delete(key);
    else buckets.set(key, fresh);
  }
}, 300_000).unref();

function rateLimit({ windowMs = 60_000, maxRequests = 30, keyByIp = false } = {}) {
  return (req, res, next) => {
    // Trust req.ip because the app sets trust proxy; clients can spoof the header directly.
    const uid = req._verifiedUid || "";
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const key = keyByIp || !uid ? `ip:${ip}` : `uid:${uid}`;

    const now = Date.now();
    const windowStart = now - windowMs;
    let timestamps = buckets.get(key) || [];
    timestamps = timestamps.filter((t) => t > windowStart);

    if (timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        ok: false,
        error: `Rate limit exceeded. Please wait ${retryAfter}s before retrying.`,
      });
    }

    timestamps.push(now);
    buckets.set(key, timestamps);
    next();
  };
}

module.exports = { rateLimit };
