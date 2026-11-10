import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Relative paths, so the built site works from any folder (GitHub Pages in Session 10).
  base: "./",
  plugins: [react(), tailwindcss()],
  // Only this PC can reach the dev server.
  server: { host: "127.0.0.1", port: 5173 },
  preview: { host: "127.0.0.1", port: 4173 },
  build: { target: "es2022" },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
