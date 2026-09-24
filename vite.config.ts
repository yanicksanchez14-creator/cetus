import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds ONE self-contained index.html (all code, map images and data inlined):
// opens by double-click and hosts for free on GitHub Pages.
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  build: { assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 10_000, target: "es2021" },
  test: { environment: "node" },
});
