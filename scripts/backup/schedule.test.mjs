import assert from "node:assert/strict";
import test from "node:test";
import {
  configProblems,
  copyDisabled,
  databaseEndpoint,
  EXIT_WARNINGS,
  msUntilNext,
  parseSummary,
  parseTime,
  pingDisabled,
  pingForRun,
  pingUrl
} from "./schedule.mjs";

test("parseTime accepts HH:mm and rejects everything else", () => {
  assert.deepEqual(parseTime("03:30"), { hours: 3, minutes: 30 });
  for (const bad of ["3:30", "24:00", "03:60", "", undefined, "0330"]) assert.throws(() => parseTime(bad), /HH:mm/);
});

test("msUntilNext waits for today's slot when it is ahead, tomorrow's when it has passed or is now", () => {
  const time = { hours: 3, minutes: 30 };
  const hour = 3_600_000;
  assert.equal(msUntilNext(new Date(2026, 9, 18, 1, 30), time), 2 * hour);
  assert.equal(msUntilNext(new Date(2026, 9, 18, 3, 30), time), 24 * hour);
  assert.equal(msUntilNext(new Date(2026, 9, 18, 4, 30), time), 23 * hour);
});

test("pingUrl builds the three healthchecks.io endpoints and returns null when unset", () => {
  assert.equal(pingUrl("https://hc-ping.com/abc/", "success"), "https://hc-ping.com/abc");
  assert.equal(pingUrl("https://hc-ping.com/abc", "fail"), "https://hc-ping.com/abc/fail");
  assert.equal(pingUrl("https://hc-ping.com/abc", "start"), "https://hc-ping.com/abc/start");
  assert.equal(pingUrl("  ", "success"), null);
  assert.equal(pingUrl(undefined, "fail"), null);
});

test("configProblems names a missing copy dir and a missing ping URL", () => {
  assert.deepEqual(configProblems({ BACKUP_COPY_DIR: "/backup-copy", BACKUP_PING_URL: "https://hc-ping.com/abc" }), []);
  assert.equal(configProblems({ BACKUP_PING_URL: "https://hc-ping.com/abc" }).length, 1);
  assert.match(configProblems({ BACKUP_COPY_DIR: "/x", BACKUP_PING_URL: " " })[0], /BACKUP_PING_URL/);
  assert.equal(configProblems({}).length, 2);
});

test("pingForRun sends success only for a clean run and puts the size in the body", () => {
  const clean = pingForRun(0, { status: "ok", backupBytes: 1234 });
  assert.equal(clean.kind, "success");
  assert.match(clean.body, /backup size: 1234 bytes/);
});

test("pingForRun sends fail for warnings, the warning exit code, and failures", () => {
  const warned = pingForRun(0, { backupBytes: 1, warnings: ["BACKUP_COPY_DIR is not set"] });
  assert.equal(warned.kind, "fail");
  assert.match(warned.body, /warning: BACKUP_COPY_DIR/);
  assert.equal(pingForRun(EXIT_WARNINGS, null).kind, "fail");
  const failed = pingForRun(1, { error: "sentinel missing" });
  assert.equal(failed.kind, "fail");
  assert.match(failed.body, /error: sentinel missing/);
});

test("a failed run's stderr summary reaches the /fail ping body", () => {
  const output = 'progress\n{"level":"error","status":"failed","error":"connect ECONNREFUSED 10.0.0.1:5432"}\n';
  const result = pingForRun(1, parseSummary(output));
  assert.equal(result.kind, "fail");
  assert.match(result.body, /error: connect ECONNREFUSED/);
});

test("parseSummary reads the last JSON line and tolerates garbage", () => {
  assert.deepEqual(parseSummary('noise\n{"status":"ok"}\n'), { status: "ok" });
  assert.equal(parseSummary("no json"), null);
  assert.equal(parseSummary("{broken"), null);
});

test("the explicit opt-outs BACKUP_COPY=off and BACKUP_PING_URL=off are accepted, in any case", () => {
  assert.deepEqual(configProblems({ BACKUP_COPY: "off", BACKUP_PING_URL: "off" }), []);
  assert.deepEqual(configProblems({ BACKUP_COPY: " OFF ", BACKUP_COPY_DIR: "", BACKUP_PING_URL: "Off" }), []);
  assert.deepEqual(configProblems({ BACKUP_COPY_DIR: "/backup-copy", BACKUP_PING_URL: "off" }), []);
  assert.deepEqual(configProblems({ BACKUP_COPY: "off", BACKUP_PING_URL: "https://hc-ping.com/abc" }), []);
  assert.ok(copyDisabled({ BACKUP_COPY: "Off" }));
  assert.ok(pingDisabled({ BACKUP_PING_URL: " OFF" }));
});

test("a blank value is still refused without its opt-out, and BACKUP_COPY_DIR is never an opt-out", () => {
  assert.equal(configProblems({ BACKUP_COPY_DIR: "", BACKUP_PING_URL: "off" }).length, 1);
  assert.equal(configProblems({ BACKUP_COPY_DIR: "none", BACKUP_PING_URL: "off" }).length, 0);
  assert.equal(configProblems({ BACKUP_COPY: "off", BACKUP_PING_URL: "  " }).length, 1);
  assert.equal(configProblems({ BACKUP_COPY: "off" }).length, 1);
  assert.equal(configProblems({ BACKUP_COPY: "", BACKUP_PING_URL: "off" }).length, 1);
  assert.equal(copyDisabled({ BACKUP_COPY_DIR: "none" }), false);
  assert.equal(copyDisabled({ BACKUP_COPY: "on" }), false);
  assert.equal(copyDisabled({}), false);
  assert.equal(pingDisabled({ BACKUP_PING_URL: "https://hc-ping.com/off" }), false);
});

test("pingUrl returns null when the ping is off, so no request is ever made", () => {
  for (const kind of ["start", "success", "fail"]) assert.equal(pingUrl("off", kind), null);
  assert.equal(pingUrl(" Off ", "success"), null);
});

test("pingForRun returns null when pings are off, and is unchanged otherwise", () => {
  assert.equal(pingForRun(0, { backupBytes: 1 }, { BACKUP_PING_URL: "off" }), null);
  assert.equal(pingForRun(1, { error: "x" }, { BACKUP_PING_URL: "off" }), null);
  assert.equal(pingForRun(0, { backupBytes: 1 }, { BACKUP_PING_URL: "https://hc-ping.com/abc" }).kind, "success");
});

test("databaseEndpoint reads host and port, defaulting to 5432, and returns null for junk", () => {
  assert.deepEqual(databaseEndpoint("postgresql://u:p@postgres:5432/openrhen"), { host: "postgres", port: 5432 });
  assert.deepEqual(databaseEndpoint("postgresql://u:p@192.0.2.57/openrhen"), {
    host: "192.0.2.57",
    port: 5432
  });
  assert.deepEqual(databaseEndpoint("postgresql://u:p@[::1]:6543/db"), { host: "::1", port: 6543 });
  assert.equal(databaseEndpoint("not a url"), null);
  assert.equal(databaseEndpoint(undefined), null);
});
