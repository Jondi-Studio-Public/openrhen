import { connectionRegistry } from "@openrhen/contracts";

// A deploy can run the checks with the live third-party credentials in the environment. The proxy reads its
// configuration straight from process.env, so tests that expect a provider to be unconfigured would see the real one. Every test starts from an unconfigured proxy
// and sets what it needs itself. The names come from the registered manifests (secrets and each connection's own
// config), so a connection added or left out of a build needs no edit here; the shared sync settings stay.
const PROVIDER_ENV = new Set(
  connectionRegistry().flatMap((manifest) => [
    ...manifest.secrets.anyOf.flat(),
    ...Object.keys(manifest.config).filter((name) => !name.startsWith("CALENDAR_SYNC_"))
  ])
);

for (const name of Object.keys(process.env)) {
  if (PROVIDER_ENV.has(name) || name.startsWith("WEB_PUSH_")) delete process.env[name];
}
