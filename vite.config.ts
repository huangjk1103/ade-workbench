import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:1717",
        changeOrigin: true,
        // SSE: don't buffer the /api/agent/stream response.
        ws: false,
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome120",
    minify: process.env.TAURI_DEBUG ? false : "oxc",
    sourcemap: Boolean(process.env.TAURI_DEBUG),
  },
});
