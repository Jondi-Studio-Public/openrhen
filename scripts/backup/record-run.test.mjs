import assert from "node:assert/strict";
import test from "node:test";
import { recordRun, statusForRun, summaryForRun } from "./record-run.mjs";

test("statusForRun: clean is synced, warnings are needs_review, anything else failed", () => {
  assert.equal(statusForRun(0, { warnings: [] }), "synced");
  assert.equal(statusForRun(0, null), "synced");
  assert.equal(statusForRun(3, { warnings: ["no copy"] }), "needs_review");
  assert.equal(statusForRun(0, { warnings: ["x"] }), "needs_review");
  assert.equal(statusForRun(1, null), "failed");
  assert.equal(statusForRun(2, { error: "boom" }), "failed");
});

test("summaryForRun keeps only a size and booleans", () => {
  const summary = { backupBytes: 42, verified: true, copiedTo: "/backups/secret/x.json", warnings: [], error: "e" };
  assert.deepEqual(summaryForRun(summary), { backupBytes: 42, copyVerified: true, restoreVerified: true });
  assert.deepEqual(summaryForRun(null), { backupBytes: null, copyVerified: false, restoreVerified: false });
  assert.equal(summaryForRun({ backupBytes: 1, verified: true, warnings: ["w"] }).copyVerified, false);
});

function fakeSql(owner) {
  const calls = [];
  const sql = async (strings, ...values) => {
    calls.push({ text: strings.join("?"), values });
    return calls.length === 1 ? (owner ? [{ id: owner }] : []) : [];
  };
  return { sql, calls };
}

test("recordRun inserts one backup row for the owner", async () => {
  const { sql, calls } = fakeSql("user-1");
  const startedAt = new Date(1);
  const finishedAt = new Date(2);
  const done = await recordRun(sql, {
    code: 3,
    summary: { backupBytes: 7, verified: true, warnings: ["w"] },
    startedAt,
    finishedAt
  });
  assert.equal(done, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /INSERT INTO integration_sync_runs/);
  assert.deepEqual(calls[1].values, [
    "user-1",
    startedAt,
    finishedAt,
    "needs_review",
    JSON.stringify({ backupBytes: 7, copyVerified: false, restoreVerified: true })
  ]);
});

test("recordRun writes nothing when there is no user yet", async () => {
  const { sql, calls } = fakeSql(null);
  assert.equal(await recordRun(sql, { code: 0, summary: null, startedAt: new Date(), finishedAt: new Date() }), false);
  assert.equal(calls.length, 1);
});
