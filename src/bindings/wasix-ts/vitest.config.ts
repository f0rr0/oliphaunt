import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@oliphaunt/liboliphaunt-wasix": fileURLToPath(
        new URL("./src/__tests__/runtime-carrier.ts", import.meta.url),
      ),
    },
  },
});
