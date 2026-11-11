import { defineConfig } from "vitest/config";

// The include is explicit so `pnpm test-files:check` can see that every test file here is run.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"]
  }
});
