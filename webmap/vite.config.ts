import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The chat assistant's backend (server/chat.mjs) runs separately on :8087 and
// holds the OpenRouter key; in dev, Vite proxies /api to it so the browser
// talks same-origin. In production set VITE_CHAT_API to the deployed chat URL.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8087",
    },
  },
});
