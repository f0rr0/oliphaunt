import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "./",
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
  },
});
