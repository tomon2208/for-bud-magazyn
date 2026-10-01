import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Testy jednostkowe — bez sieci i bez bazy (uruchamiane w CI).
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // "server-only" rzuca wyjątek poza bundlerem Next — w testach zastępujemy pustym modułem.
      "server-only": fileURLToPath(new URL("./tests/stubs/empty.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
