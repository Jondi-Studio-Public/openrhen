import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { SmokeFailure, databaseUrlFor, findFreePort, resolveTestDatabaseUrl, scratchDatabase } from "./boot.mjs";
import { assertSeedTarget, phaseEnv, seedDatabaseName, seedEnv } from "./seed-phase.mjs";

const TEST_NAME = /^[A-Za-z][A-Za-z0-9_]*_test$/;

test("the seed phase's database is a _test name of its own, never the click phase's or an integration run's", () => {
  const name = seedDatabaseName("openrhen_test", 4242, Date.parse("2026-10-28T01:00:00Z"));
  assert.match(name, TEST_NAME);
  assert.notEqual(name, "openrhen_test");
  assert.match(name, /^openrhen_seedsmoke4242x[a-z0-9]+_test$/);
  // Integration suites mint `<base>_r<pid><time>_test` and drop `%_<suffix>_test`; this can never match one.
  assert.doesNotMatch(name, /_r[a-z0-9]+_test$/);
});

test("two runs get two names, and a long base still fits a Postgres identifier", () => {
  const first = seedDatabaseName("openrhen_test", 1, 1_000);
  assert.notEqual(first, seedDatabaseName("openrhen_test", 2, 1_000));
  assert.notEqual(first, seedDatabaseName("openrhen_test", 1, 2_000));
  const long = seedDatabaseName(`${"x".repeat(80)}_test`, 99999999, Date.now());
  assert.ok(long.length <= 63, `${long.length} characters`);
  assert.match(long, TEST_NAME);
});

test("the seed phase's environment drops what points elsewhere and keeps what it sets", () => {
  const base = {
    PATH: "/bin",
    DATABASE_URL: "postgres://live/openrhen",
    OPENRHEN_URL: "http://192.0.2.41:8787",
    OPENRHEN_OWNER_TOKEN: "owner",
    OPENRHEN_OWNER_AUTH: "require",
    PORTAL_INTERNAL_URL: "http://portal:3000",
    PLAN_FORECAST_SERVICE_TOKEN: "live-token",
    DEMO_SEED_FORCE: "1",
    DEMO_SEED_NOW: "2026-01-01T00:00:00Z"
  };
  const env = phaseEnv(base, { DATABASE_URL: "postgres://127.0.0.1/openrhen_seedsmoke1x1_test" });
  assert.equal(env.DATABASE_URL, "postgres://127.0.0.1/openrhen_seedsmoke1x1_test");
  assert.equal(env.PATH, "/bin");
  for (const key of [
    "OPENRHEN_URL",
    "OPENRHEN_OWNER_TOKEN",
    "OPENRHEN_OWNER_AUTH",
    "PORTAL_INTERNAL_URL",
    "PLAN_FORECAST_SERVICE_TOKEN"
  ])
    assert.equal(key in env, false, key);
  // Blank rather than absent, so the seed's own .env load cannot fill them in.
  assert.equal(env.DEMO_SEED_FORCE, "");
  assert.equal(env.DEMO_SEED_NOW, "");
  assert.equal(base.DATABASE_URL, "postgres://live/openrhen", "the base environment is left alone");
});

test("a database URL keeps the server and credentials and swaps only the database", () => {
  assert.equal(
    databaseUrlFor(
      "postgresql://postgres:secret@127.0.0.1:5433/postgres?sslmode=disable",
      "openrhen_seedsmoke1x1_test"
    ),
    "postgresql://postgres:secret@127.0.0.1:5433/openrhen_seedsmoke1x1_test?sslmode=disable"
  );
  const scratch = scratchDatabase("postgresql://postgres:secret@127.0.0.1:5433/postgres", "a_seedsmoke1x1_test");
  assert.equal(scratch.name, "a_seedsmoke1x1_test");
  assert.equal(new URL(scratch.url).pathname, "/a_seedsmoke1x1_test");
});

test("the test database comes from the admin URL, and a name that is not _test is refused", () => {
  const saved = { ...process.env };
  try {
    process.env.POSTGRES_ADMIN_URL = "postgresql://u:p@127.0.0.1:5999/postgres?sslmode=disable";
    process.env.TEST_DATABASE_NAME = "demo_test";
    const resolved = resolveTestDatabaseUrl();
    assert.equal(resolved.testDatabaseName, "demo_test");
    assert.equal(resolved.adminUrl, process.env.POSTGRES_ADMIN_URL);
    assert.equal(resolved.testDatabaseUrl, "postgresql://u:p@127.0.0.1:5999/demo_test?sslmode=disable");

    process.env.TEST_DATABASE_NAME = "demo";
    assert.throws(() => resolveTestDatabaseUrl(), SmokeFailure);
  } finally {
    for (const key of ["POSTGRES_ADMIN_URL", "TEST_DATABASE_NAME"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("a free port is one a server can then take", async () => {
  const port = await findFreePort();
  assert.ok(Number.isInteger(port) && port > 0);
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
});

test("the seed is pointed only at the phase's own database, on this machine or the LAN Postgres", () => {
  const own = "openrhen_seedsmoke1x1_test";
  assert.doesNotThrow(() => assertSeedTarget(`postgresql://u:p@127.0.0.1:5432/${own}?sslmode=disable`, own));
  assert.doesNotThrow(() => assertSeedTarget(`postgresql://u:p@10.20.30.57:5432/${own}?sslmode=disable`, own));
  assert.throws(() => assertSeedTarget("postgresql://u:p@10.20.30.57:5432/openrhen", own), SmokeFailure);
  assert.throws(() => assertSeedTarget("postgresql://u:p@127.0.0.1:5432/openrhen_test", own), SmokeFailure);
  assert.throws(() => assertSeedTarget("postgresql://u:p@127.0.0.1:5432/openrhen", own), SmokeFailure);
  assert.throws(() => assertSeedTarget(`postgresql://u:p@db.example.com:5432/${own}`, own), SmokeFailure);
});

test("the seed's environment blanks what the phase dropped, so the workspace .env cannot fill it back", () => {
  const env = phaseEnv({ OPENRHEN_TOKEN: "pt_live", OPENRHEN_AGENT: "openclaw", PATH: "/bin" }, {});
  const seeded = seedEnv(env, { OPENRHEN_URL: "http://127.0.0.1:4000" });
  assert.equal(seeded.OPENRHEN_TOKEN, "");
  assert.equal(seeded.OPENRHEN_AGENT, "");
  assert.equal(seeded.OPENRHEN_URL, "http://127.0.0.1:4000");
  assert.equal(seeded.PATH, "/bin");
});
