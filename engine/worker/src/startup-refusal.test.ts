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

describe("engine worker startup refusal", () => {
  it(
    "stops with one line, and a hint that fits an external database, when DATABASE_URL is missing",
    () => {
      const result = start({});
      expect(result.status).toBe(1);
      const lines = result.stderr.trim().split("\n");
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as { level: string; message: string };
      expect(entry.level).toBe("error");
      expect(entry.message).toMatch(/^OpenRhen cannot start: DATABASE_URL is required/);
      expect(entry.message).toMatch(/Set it in \.env/);
      expect(result.stderr).not.toMatch(/\n\s+at /);
      expect(result.stderr).not.toContain("secret-value");
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    "stops with one line when the service token is missing",
    () => {
      const result = start({ DATABASE_URL: "postgresql://x:secret-value@127.0.0.1:1/x" });
      expect(result.status).toBe(1);
      const lines = result.stderr.trim().split("\n");
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as { level: string; message: string };
      expect(entry.level).toBe("error");
      expect(entry.message).toMatch(/^OpenRhen cannot start: PLAN_FORECAST_SERVICE_TOKEN is required/);
      expect(entry.message).toMatch(/docker compose run --rm setup/);
      expect(result.stderr).not.toMatch(/\n\s+at /);
      expect(result.stderr).not.toContain("secret-value");
    },
    SPAWN_TIMEOUT_MS
  );
});
