import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The chat assistant's backend (server/chat.mjs) runs separately on :8087 and
// holds the OpenRouter key; in dev, Vite proxies /api to it so the browser
// talks same-origin. In production set VITE_CHAT_API to the deployed chat URL.
export default defineConfig({
  plugins: [react()],
  server: {
    // Leading dot = this host and all subdomains, so any *.ngrok-free.app
    // tunnel can reach the dev server without a config change per session.
    allowedHosts: [".ngrok-free.app"],
    // Same-origin proxies for the two backends the browser calls directly.
    // Set VITE_STAC_API=/stac and VITE_TITILER=/titiler to use them: behind an
    // HTTPS tunnel (ngrok) the browser blocks http://localhost:8082 as insecure
    // mixed content, and on any device that isn't this laptop "localhost" is
    // the wrong machine anyway. Going through the dev server also sidesteps CORS.
    proxy: {
      "/api": "http://localhost:8087",
      "/stac": {
        target: "http://localhost:8082",
        rewrite: (p) => p.replace(/^\/stac/, ""),
      },
      "/titiler": {
        target: "http://localhost:8083",
        rewrite: (p) => p.replace(/^\/titiler/, ""),
      },
    },
  },
});
