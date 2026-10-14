import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// IMPORTANT: must match your Firebase project + region
const PROJECT_ID = "travelmateai-5a3a8";
const REGION = "asia-southeast1";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Vendor chunks keep every file under 500 KB and cache across deploys.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]@firebase[\\/]firestore[\\/]/.test(id)) return "firebase-firestore";
          if (/[\\/]@?firebase[\\/]/.test(id)) return "firebase";
          if (/[\\/](react|react-dom|react-router|react-router-dom|@remix-run|scheduler)[\\/]/.test(id)) return "react";
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      /**
       * Browser calls:  http://localhost:5173/api/v1/chat
       * Vite forwards:  http://127.0.0.1:5001/<PROJECT_ID>/<REGION>/api/v1/chat
       */
      "/api": {
        target: `http://127.0.0.1:5001/${PROJECT_ID}/${REGION}`,
        changeOrigin: true,
        secure: false,

        // Keep /api prefix so it hits the Firebase function named "api"
        rewrite: (path) => path,
      },
    },
  },
});
