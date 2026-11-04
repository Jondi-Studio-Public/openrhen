#!/usr/bin/env node
// The server's backup loop (compose service `backup`): wait for BACKUP_TIME, run backup-and-copy.mjs, report to a
// dead-man's-switch monitor, repeat. The monitor is the missed-backup alert: if no success ping arrives within its
// grace period, it alerts, which a script that only exits non-zero on failure could never do when the whole
// container is down. the design notes
//
//   BACKUP_ENABLED      must be "true" to schedule anything; otherwise the container idles, so deploying the image changes nothing
//   BACKUP_TIME          24-hour HH:mm in TZ (default 03:30)
//   BACKUP_RUN_ON_START  "true" runs once at start, then daily (use it to prove the setup)
//   BACKUP_COPY_DIR      required when enabled (the share, with .openrhen-backup-target at its root), unless
//   BACKUP_COPY          "off" keeps backups on this machine only (BACKUP_COPY_DIR may then be blank)
//   BACKUP_PING_URL      required when enabled: healthchecks.io check URL, or "off" for no monitor. A run with any warning pings /fail; the
//                        POST body carries the backup size. Missing COPY_DIR or PING_URL exits non-zero at start
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordRunToDatabase } from "./record-run.mjs";
import {
  configProblems,
  copyDisabled,
  databaseEndpoint,
  msUntilNext,
  parseSummary,
  parseTime,
  pingDisabled,
  pingForRun,
  pingUrl
} from "./schedule.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "backup-and-copy.mjs");
const time = parseTime(process.env.BACKUP_TIME ?? "03:30");
const pingBase = process.env.BACKUP_PING_URL;
let stopping = false;
let timer;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopping = true;
    clearTimeout(timer);
    process.exit(0);
  });
}

if (process.env.BACKUP_ENABLED !== "true") {
  log("info", "Scheduled backup is disabled; set BACKUP_ENABLED=true on the server to turn it on.");
  setInterval(() => {}, 2 ** 30); // idle rather than exit, so restart: unless-stopped does not loop
  await new Promise(() => {});
}

// Enabled without an off-machine copy or a monitor is a setup that looks like protection and is not: refuse to start.
const problems = configProblems(process.env);
if (problems.length > 0) {
  for (const problem of problems) log("error", `Backup is enabled but misconfigured: ${problem}`);
  process.exit(1);
}

log("info", "Backup loop started", {
  time: process.env.BACKUP_TIME ?? "03:30",
  copy: copyDisabled(process.env) ? "off (local only)" : "on",
  ping: pingDisabled(process.env) ? "off" : "on"
});

if (process.env.BACKUP_RUN_ON_START === "true") {
  // A fresh `up` starts this beside a database that may still be initialising; give it time rather than fail the proof run.
  await waitForDatabase(90_000);
  await runOnce();
}
while (!stopping) {
  const wait = msUntilNext(new Date(), time);
  log("info", "Next backup scheduled", { at: new Date(Date.now() + wait).toISOString() });
  await new Promise((done) => (timer = setTimeout(done, wait)));
  if (!stopping) await runOnce();
}

async function runOnce() {
  const startedAt = new Date();
  await ping("start");
  let output = "";
  const code = await new Promise((done) => {
    // Both streams: the success summary goes to stdout, the failure summary (with the real error) to stderr.
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", () => done(1));
    child.on("exit", (exit) => done(exit ?? 1));
  });
  // A run that finished with any warning is /fail, not success: a green ping must mean nothing needs attention.
  const summary = parseSummary(output);
  const result = pingForRun(code, summary, process.env);
  if (result) await ping(result.kind, result.body);
  await record({ code, summary, startedAt, finishedAt: new Date() });
}

/** Waits up to `limitMs` for DATABASE_URL's host to accept TCP connections. Never throws: the run itself reports a real failure. */
async function waitForDatabase(limitMs) {
  const endpoint = databaseEndpoint(process.env.DATABASE_URL);
  if (!endpoint) return;
  const deadline = Date.now() + limitMs;
  while (!stopping) {
    const reachable = await new Promise((done) => {
      const socket = connect({ ...endpoint, timeout: 3000 });
      socket.once("connect", () => (socket.destroy(), done(true)));
      socket.once("timeout", () => (socket.destroy(), done(false)));
      socket.once("error", () => (socket.destroy(), done(false)));
    });
    if (reachable) return;
    if (Date.now() >= deadline) {
      log("warn", "Database was not reachable after waiting; running the first backup anyway", { waitedMs: limitMs });
      return;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
}

/** Lets the portal see the run. Best effort: a failure here only logs, and never touches the backup or its ping. */
async function record(run) {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  try {
    await recordRunToDatabase(url, run);
  } catch (error) {
    // The message can echo the connection string, so log only the error class.
    log("warn", "Backup run was not recorded", { error: error instanceof Error ? error.name : "Error" });
  }
}

/** A monitor outage must never stop a backup, so a failed ping only logs. */
async function ping(kind, body) {
  const url = pingUrl(pingBase, kind);
  if (!url) return;
  try {
    const response = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) log("warn", "Backup monitor ping was refused", { kind, status: response.status });
  } catch (error) {
    log("warn", "Backup monitor ping failed", { kind, error: error instanceof Error ? error.message : String(error) });
  }
}

function log(level, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level, message, ...fields })}\n`);
}
