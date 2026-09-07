import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /yt → локальный server.js-прокси (обход CORS) в dev-режиме;
// в проде (server.js) прокси остаётся на том же origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/yt": {
        target: "http://localhost:8414",
        changeOrigin: false,
      },
    },
  },
});
