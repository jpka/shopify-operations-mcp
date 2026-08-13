import { defineConfig } from "vitest/config";

// Integration tests are env-gated: they exercise a live Shopify store and need
// SHOPIFY_STORE_URL / SHOPIFY_ACCESS_TOKEN, so they are not part of default
// `npm test` and never run on CI. This config backs `npm run test:integration`;
// the suite is a no-op placeholder until integration tests land in a later
// ticket — passWithNoTests keeps the script green meanwhile.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: false,
    environment: "node",
  },
});
