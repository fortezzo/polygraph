import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Relative paths, so the built site works from any folder (GitHub Pages in Session 10).
  base: "./",
  plugins: [react(), tailwindcss()],
  // Only this PC can reach the dev server. Live mode (Session 8) talks to
  // Polygraph's server through it, at the same address, so the browser never
  // talks to another origin. The preview (npm run phone, reachable from your
  // Wi-Fi) has no such pass-through, so live mode stays on this PC.
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8420", changeOrigin: true } },
  },
  preview: { host: "127.0.0.1", port: 4173 },
  build: { target: "es2022" },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
