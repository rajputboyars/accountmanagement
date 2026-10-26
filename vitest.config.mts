import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // One disposable PostgreSQL container per run; every test file gets its own database cloned
    // from a migrated template (tests/helpers/test-db.ts). Never touches the developer database.
    globalSetup: ["tests/setup/global-setup.ts"],
    setupFiles: ["tests/setup/test-env.ts"],
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
