import { defineConfig } from "vitest/config";

// Live integration suite (env-gated, manual-only): exercises the real Shopify
// Admin API against the seeded dev store (`npm run seed`). Every test file
// under tests/integration skips itself unless SHOPIFY_STORE_DOMAIN AND
// SHOPIFY_ADMIN_TOKEN are both set, so the script passes as a no-op without
// credentials and — deliberately — never runs on CI (no secrets, no
// rate-limit flakes). Run it with:
//
//   SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_TOKEN=... npm run test:integration
//
// Files run serially (fileParallelism: false) because the suite shares one
// mutable store: the destructive cancel/refund tests mutate orders the read
// tests count, so files must never race.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: false,
    environment: "node",
  },
});
