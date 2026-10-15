import { defineConfig } from "vitest/config";

// Integration suite — excluded from the default vitest.config.ts (heavier
// end-to-end renderer fakes). Fake bot, no network; safe to run anywhere.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
