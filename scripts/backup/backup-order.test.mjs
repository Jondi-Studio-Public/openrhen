import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// backup-and-copy.mjs runs on import, so its step order is checked from its source. The restore check fails
// when a photo the backup names is missing from the copy folder, so the photos must be copied first.
test("photos are copied before the backup is verified, and the backup is verified before it is copied", async () => {
  const source = await readFile(new URL("./backup-and-copy.mjs", import.meta.url), "utf8");
  const at = (call) => source.indexOf(call);
  assert.ok(at("await createBackup()") > -1);
  assert.ok(at("await createBackup()") < at("await copyPhotos()"));
  assert.ok(at("await copyPhotos()") < at("await verifyBackup("));
  assert.ok(at("await verifyBackup(") < at("await copyBackup("));
});

// With BACKUP_COPY=off the run is local-only on purpose: one info line, no warning, so it exits 0 and pings success.
test("BACKUP_COPY=off skips the copy and photo sync without a warning, while a blank dir still warns", async () => {
  const source = await readFile(new URL("./backup-and-copy.mjs", import.meta.url), "utf8");
  const copyBackup = source.slice(
    source.indexOf("async function copyBackup("),
    source.indexOf("async function prune(")
  );
  const optedOut = copyBackup.slice(copyBackup.indexOf("if (copyOptedOut)"), copyBackup.indexOf("if (!copyDirectory)"));
  assert.match(optedOut, /level: "info"/);
  assert.match(optedOut, /return null/);
  assert.doesNotMatch(optedOut, /warnings\.push/);
  assert.match(copyBackup, /if \(!copyDirectory\) \{\s+warnings\.push\("BACKUP_COPY_DIR is not set/);
  // No directory is set when opted out, so the guard, photo sync and copy-folder prune are all skipped.
  assert.match(source, /const copyDirectory = copyOptedOut \? undefined : /);
  assert.match(source, /if \(copyDirectory\) await assertBackupTarget\(/);
  assert.match(source, /if \(!copyDirectory\) return null;/);
});
