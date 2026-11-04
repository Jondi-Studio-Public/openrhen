import vinext from "vinext";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { config as readDotenv } from "dotenv";
import { portalSecurityHeaders } from "./server/security/browser-headers";

const portalRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceEnv = fileURLToPath(new URL("../.env", import.meta.url));

// The portal is a plain Node server. `output: "standalone"` makes `vinext build` emit
// dist/standalone/ — server.js plus only the runtime dependencies the server bundle actually
// imports — so the container's runtime stage copies one directory and needs no install.
// Configuration is read from process.env at run time (see server/runtime-env.ts), so the build
// takes no secrets and none land in an image layer.
export default defineConfig(({ command }) => {
  // One `.env` for the whole workspace, and it sits a directory above this one. vinext reads
  // portal/.env by itself but not the root, so load it here for `pnpm dev`; neither loader
  // overwrites a variable already in the environment. The production build reads nothing.
  if (command === "serve") readDotenv({ path: workspaceEnv, quiet: true });
  return {
    resolve: { alias: { "@": portalRoot } },
    // jszip's plain-CJS internals (lib/base64.js etc.) trip Vite's dev-only SSR module
    // runner CJS interop (a known vinext/Vite 8 gap — see vinext's README on "stricter
    // CommonJS default import handling"). Externalizing it for `serve` only sends it
    // through Node's native `require` in dev instead of the module runner's transform.
    // The production build is untouched: `noExternal: true` there still bundles jszip
    // into the SSR chunk exactly as before.
    ssr: { external: command === "serve" ? ["jszip"] : [] },
    plugins: [vinext({ nextConfig: { output: "standalone", headers: async () => portalSecurityHeaders() } })]
  };
});
