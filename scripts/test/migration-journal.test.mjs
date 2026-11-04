import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  baselineChangeProblems,
  baselineProblems,
  checkMigrationsDir,
  journalChangeProblems,
  journalProblems,
  parseDir
} from "../ci/migration-journal.mjs";

const entry = (idx, when, tag = `${String(idx).padStart(4, "0")}_m`) => ({ idx, tag, when });
const files = (snapshots = {}) => ({
  sql: () => true,
  snapshot: (idx) => snapshots[idx]
});
const chain = (...idxs) =>
  Object.fromEntries(idxs.map((idx, i) => [idx, { id: `s${idx}`, prevId: i ? `s${idxs[i - 1]}` : "root" }]));

test("journalProblems: contiguous from the start idx, tag prefix, increasing when", () => {
  const snaps = chain(5, 6);
  assert.deepEqual(journalProblems([entry(5, 10), entry(6, 20)], files(snaps), { start: 5 }), []);
  assert.match(journalProblems([entry(5, 10), entry(6, 20)], files(snaps))[0], /idx must run 0, 1, 2/);
  assert.match(
    journalProblems([entry(5, 10), entry(7, 20, "0007_m")], files(chain(5, 7)), { start: 5 })[0],
    /idx must run 5, 6, 7/
  );
  assert.match(
    journalProblems([entry(5, 10, "0006_m")], files(chain(5)), { start: 5 }).join("\n"),
    /tag must start 0005_/
  );
  assert.match(
    journalProblems([entry(5, 10), entry(6, 10)], files(snaps), { start: 5 }).join("\n"),
    /not later than the entry before/
  );
});

test("journalProblems: sql files and the snapshot prevId chain", () => {
  assert.match(
    journalProblems([entry(0, 1)], { sql: () => false, snapshot: () => ({ id: "a" }) })[0],
    /has no .*\.sql/
  );
  assert.match(journalProblems([entry(0, 1)], files())[0], /no meta\/0000_snapshot/);
  const forked = { 0: { id: "a", prevId: "root" }, 1: { id: "b", prevId: "zzz" } };
  assert.match(journalProblems([entry(0, 1), entry(1, 2)], files(forked)).join("\n"), /prevId zzz/);
  // NO_SNAPSHOT is legacy-idx specific and harmless elsewhere: idx 8 needs no snapshot, idx 139 does.
  assert.deepEqual(journalProblems([entry(8, 1)], files(), { start: 8 }), []);
  assert.equal(journalProblems([entry(139, 1)], files(), { start: 139 }).length, 1);
  assert.deepEqual(journalProblems([entry(139, 1)], files(), { start: 139, noSnapshot: new Set([139]) }), []);
});

const legacyRows = (n, base = 100) => Array.from({ length: n }, (_, idx) => ({ idx, when: base + idx, hashes: ["h"] }));
const baseline = (extra = {}) => ({
  version: 1,
  baselineIdx: 2,
  legacy: legacyRows(3),
  laterLegacy: [{ idx: 3, when: 200, hashes: ["h"], exported: true }],
  ...extra
});
const goodEntries = () => [entry(2, 102), entry(3, 200), entry(4, 300)];

test("baselineProblems: a good core baseline passes", () => {
  assert.deepEqual(baselineProblems(baseline(), goodEntries()), []);
  assert.deepEqual(baselineProblems(baseline({ laterLegacy: undefined }), [entry(2, 102), entry(3, 103)]), []);
});

test("baselineProblems: legacy idx run and increasing when", () => {
  const gap = baseline({ legacy: [legacyRows(3)[0], legacyRows(3)[2]] });
  assert.match(baselineProblems(gap, goodEntries()).join("\n"), /legacy entry 1 has idx 2/);
  const flat = baseline({ legacy: legacyRows(3).map((row) => ({ ...row, when: 100 })) });
  assert.match(
    baselineProblems(flat, [entry(2, 100), entry(3, 200), entry(4, 300)]).join("\n"),
    /not later than idx 0/
  );
});

test("baselineProblems: baseline entry when equals the last legacy when (core only)", () => {
  const entries = [entry(2, 150), entry(3, 200), entry(4, 300)];
  assert.match(baselineProblems(baseline(), entries).join("\n"), /last legacy when is 102/);
  assert.deepEqual(baselineProblems(baseline({ legacyLedger: "core" }), entries), []);
  assert.match(baselineProblems(baseline(), [entry(3, 102)]).join("\n"), /journal starts at idx 3/);
});

test("baselineProblems: laterLegacy continues contiguously and matches the journal", () => {
  const skipped = baseline({ laterLegacy: [{ idx: 4, when: 200, hashes: ["h"] }] });
  assert.match(baselineProblems(skipped, [entry(2, 102)]).join("\n"), /laterLegacy entry 0 has idx 4/);
  const listed = baselineProblems(baseline(), [entry(2, 102), entry(3, 201), entry(4, 300)]);
  assert.match(listed.join("\n"), /0003_m has when 201 but baseline.json laterLegacy has 200/);
  // A private-only laterLegacy migration (idx 4, not exported) is not in the journal; the next new entry follows it.
  const privateOnly = baseline({
    laterLegacy: [
      { idx: 3, when: 200, hashes: ["h"], exported: true },
      { idx: 4, when: 250, hashes: ["h"] }
    ]
  });
  assert.deepEqual(baselineProblems(privateOnly, [entry(2, 102), entry(3, 200), entry(5, 400, "0005_m")]), []);
  assert.match(
    baselineProblems(privateOnly, [entry(2, 102), entry(3, 200), entry(5, 240, "0005_m")]).join("\n"),
    /not later than the newest legacy/
  );
  const missingFromLater = baseline({ laterLegacy: [{ idx: 4, when: 250, hashes: ["h"] }] });
  assert.match(
    baselineProblems(missingFromLater, goodEntries()).join("\n"),
    /0003_m is in the journal but not in baseline.json laterLegacy/
  );
  const exportedAbsent = baseline({ laterLegacy: [{ idx: 3, when: 200, hashes: ["h"], exported: true }] });
  assert.match(
    baselineProblems(exportedAbsent, [entry(2, 102)]).join("\n"),
    /marked exported but the journal has no such entry/
  );
});

test("baselineProblems: S6, a new core entry is later than every legacy and laterLegacy when", () => {
  assert.match(
    baselineProblems(baseline(), [entry(2, 102), entry(3, 200), entry(4, 150)]).join("\n"),
    /0004_m has when 150, not later than the newest legacy/
  );
  assert.match(
    baselineProblems(baseline(), [entry(2, 102), entry(3, 200), entry(4, 200)]).join("\n"),
    /not later than the newest legacy/
  );
  // A laterLegacy-only newest when counts: 300 is later than legacy (102) but not than laterLegacy 400.
  const high = baseline({ laterLegacy: [{ idx: 3, when: 400, hashes: ["h"], exported: true }] });
  assert.match(
    baselineProblems(high, [entry(2, 102), entry(3, 400), entry(4, 300)]).join("\n"),
    /newest legacy migration \(400\)/
  );
  // The add-on set shares core's ledger and has no such rule.
  assert.deepEqual(
    baselineProblems(baseline({ legacyLedger: "core" }), [entry(2, 102), entry(3, 200), entry(4, 150)]),
    []
  );
});

test("journalChangeProblems: prefix unchanged, new entries later", () => {
  const base = [entry(2, 10), entry(3, 20)];
  assert.deepEqual(journalChangeProblems(base, [...base, entry(4, 30)]), []);
  assert.match(journalChangeProblems(base, [entry(2, 10)]).join("\n"), /missing here/);
  assert.match(journalChangeProblems(base, [entry(2, 10), entry(3, 21)]).join("\n"), /keep its place, tag and when/);
  assert.match(journalChangeProblems(base, [...base, entry(4, 20)]).join("\n"), /not later than main's newest/);
});

test("checkMigrationsDir and parseDir work on a folder on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "journal-"));
  try {
    mkdirSync(join(dir, "meta"));
    writeFileSync(join(dir, "0005_a.sql"), "");
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ entries: [entry(5, 10, "0005_a")] }));
    writeFileSync(join(dir, "meta/0005_snapshot.json"), JSON.stringify({ id: "a", prevId: "root" }));
    assert.match(checkMigrationsDir(dir).join("\n"), /idx must run 0/);
    writeFileSync(
      join(dir, "meta/baseline.json"),
      JSON.stringify({
        version: 1,
        baselineIdx: 5,
        legacy: legacyRows(6, 0).map((r, i) => ({ ...r, when: i === 5 ? 10 : i }))
      })
    );
    assert.deepEqual(checkMigrationsDir(dir), []);
    assert.equal(parseDir(["--dir", dir]), dir);
    assert.match(parseDir([]), /platform\/database\/drizzle$/);
    assert.throws(() => parseDir(["--dir"]), /needs a migrations folder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real core set passes", () => {
  assert.deepEqual(checkMigrationsDir(parseDir([])), []);
});

test("baselineChangeProblems lets a sync append laterLegacy rows but not change what main has", () => {
  const base = { baselineIdx: 3, legacy: [{ idx: 0, when: 1 }], laterLegacy: [{ idx: 4, when: 5 }] };
  assert.deepEqual(baselineChangeProblems(undefined, base), []);
  assert.deepEqual(
    baselineChangeProblems(base, { ...base, laterLegacy: [...base.laterLegacy, { idx: 5, when: 6 }] }),
    []
  );
  assert.equal(baselineChangeProblems(base, { ...base, laterLegacy: [{ idx: 4, when: 9 }] }).length, 1);
  assert.equal(baselineChangeProblems(base, { ...base, laterLegacy: [] }).length, 1);
  assert.equal(baselineChangeProblems(base, { ...base, legacy: [] }).length, 1);
  assert.equal(baselineChangeProblems(base, { ...base, baselineIdx: 4 }).length, 1);
  assert.equal(baselineChangeProblems(base, undefined).length, 1);
});
