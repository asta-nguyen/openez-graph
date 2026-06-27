import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "path";
import { API_PORT, VITE_PORT } from "./src/lib/constants";

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: VITE_PORT,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_PORT ?? API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
