import { defineConfig } from "vite";

// Temporary dev-preview config for iterating on styles with HMR.
export default defineConfig({
  root: "src/web",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4097",
      "/health": "http://localhost:4097",
    },
  },
});
