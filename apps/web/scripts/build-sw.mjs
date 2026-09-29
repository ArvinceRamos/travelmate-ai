// apps/web/scripts/build-sw.mjs
import { build, loadEnv } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Load env from apps/web/.env (only VITE_* keys)
const env = loadEnv(process.env.NODE_ENV || "development", root, "VITE_");

function need(name) {
  const v = env[name];
  if (!v) throw new Error(`[build:sw] Missing ${name} in apps/web/.env`);
  return v;
}

await build({
  root,
  configFile: false,
  publicDir: false,
  define: {
    "__VITE_FIREBASE_API_KEY__": JSON.stringify(need("VITE_FIREBASE_API_KEY")),
    "__VITE_FIREBASE_AUTH_DOMAIN__": JSON.stringify(need("VITE_FIREBASE_AUTH_DOMAIN")),
    "__VITE_FIREBASE_PROJECT_ID__": JSON.stringify(need("VITE_FIREBASE_PROJECT_ID")),
    "__VITE_FIREBASE_STORAGE_BUCKET__": JSON.stringify(need("VITE_FIREBASE_STORAGE_BUCKET")),
    "__VITE_FIREBASE_MESSAGING_SENDER_ID__": JSON.stringify(need("VITE_FIREBASE_MESSAGING_SENDER_ID")),
    "__VITE_FIREBASE_APP_ID__": JSON.stringify(need("VITE_FIREBASE_APP_ID"))
  },
  build: {
    emptyOutDir: false,
    outDir: path.resolve(root, "public"),
    rollupOptions: {
      input: path.resolve(root, "src/notifications/firebase-messaging-sw.js"),
      output: {
        entryFileNames: "firebase-messaging-sw.js",
        format: "es"
      }
    }
  }
});

console.log("✅ Built apps/web/public/firebase-messaging-sw.js");
