import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Loading an entry point through tsx is slow when many suites run at once; stay inside the spawn timeout below.
const SPAWN_TIMEOUT_MS = 30_000;

/**
 * Starts the real entry point with a setting missing, as a misconfigured container would. It must stop at once
 * with one readable line, not a stack trace, and the line may name a setting but never print a value.
 */
function start(env: Record<string, string>) {
  const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
  return spawnSync(process.execPath, ["--import", "tsx", entry], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS
  });
}

describe("outbound proxy startup refusal", () => {
  it(
    "stops with one line when the token is missing",
    () => {
      const result = start({});
      expect(result.status).toBe(1);
      const lines = result.stderr.trim().split("\n");
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as { level: string; message: string };
      expect(entry.level).toBe("error");
      expect(entry.message).toMatch(/^OpenRhen cannot start: OUTBOUND_PROXY_TOKEN is required/);
      expect(entry.message).toMatch(/docker compose run --rm setup/);
      expect(result.stderr).not.toMatch(/\n\s+at /);
      expect(result.stderr).not.toContain("secret-value");
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    "stops with one line when the token is still the placeholder",
    () => {
      const result = start({ OUTBOUND_PROXY_TOKEN: "replace-before-lan-use" });
      expect(result.status).toBe(1);
      const lines = result.stderr.trim().split("\n");
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as { level: string; message: string };
      expect(entry.level).toBe("error");
      expect(entry.message).toMatch(/^OpenRhen cannot start: OUTBOUND_PROXY_TOKEN is still the compose placeholder/);
      expect(entry.message).toMatch(/docker compose run --rm setup/);
      expect(result.stderr).not.toMatch(/\n\s+at /);
      expect(result.stderr).not.toContain("secret-value");
    },
    SPAWN_TIMEOUT_MS
  );
});
