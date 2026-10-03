import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  publicDir: path.resolve(import.meta.dirname, "public"),
  plugins: [vue()],
  resolve: {
    alias: {
      // Vendored ShogiHome files keep their original "@/..." imports.
      "@": path.resolve(import.meta.dirname, "src/renderer/vendor/shogihome"),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:3210" },
  },
});
