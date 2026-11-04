import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const portalRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Two kinds of unit test share this config. Pure `.test.ts` files run under Node. Component
 * `.test.tsx` files opt into a DOM with `// @vitest-environment jsdom` on their first line and render
 * through `@/test/render`, so nothing else in the setup differs and a `.ts` test can never depend on
 * a browser global by accident.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": portalRoot,
      // `vinext dev`/`vinext build` resolve "next/*" specifiers to vinext's shims through its own
      // Vite plugin (see vite.config.ts), which this lighter test config does not load. Aliasing the
      // two shims components actually import — Link and the App Router navigation hooks — keeps
      // component tests on the same runtime code the app ships, without pulling in the full plugin
      // (which expects a running vinext server context tests do not have).
      "next/link": "vinext/shims/link",
      "next/navigation": "vinext/shims/navigation"
    }
  },
  test: {
    environment: "node",
    // The default Host allowlist is closed; suites send `Host: portal.test`, so name it once here.
    env: { PORTAL_PUBLIC_URL: "https://portal.test" },
    setupFiles: ["./test/persona-defaults.ts"],
    include: [
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "components/**/*.test.ts",
      "components/**/*.test.tsx",
      "drop-ins/**/*.test.ts",
      "features/**/*.test.ts",
      "features/**/*.test.tsx",
      "integrations/**/*.test.ts",
      "server/**/*.test.ts",
      "shared/**/*.test.ts",
      "state/**/*.test.ts",
      "state/**/*.test.tsx",
      "test/**/*.test.ts",
      "test/**/*.test.tsx"
    ],
    exclude: ["**/*.integration.test.ts"],
    // CI's unit job shares the PC with the integration and check jobs, and under that load
    // component tests that take half a second alone have run past the 5 s default.
    ...(process.env.CI ? { testTimeout: 30_000 } : {})
  }
});
