import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file boots its own in-process PostgreSQL (PGlite WASM).
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
