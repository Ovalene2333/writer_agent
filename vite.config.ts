import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    // Keep the warning useful, but main app source is large by nature.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("\\react\\")) {
            return "react-vendor";
          }
          if (id.includes("lucide-react")) return "lucide";
          if (id.includes("marked")) return "marked";
          return "vendor";
        },
      },
    },
  },
});
