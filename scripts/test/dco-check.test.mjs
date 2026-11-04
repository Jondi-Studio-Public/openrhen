import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { dcoProblems, parseSignoffEmails } from "../ci/dco-check.mjs";

const RENOVATE_EMAIL = "29139614+renovate[bot]@users.noreply.github.com";
const human = { login: "someone", type: "User" };
const renovate = { login: "renovate[bot]", type: "Bot" };
const commit = (over = {}) => ({
  sha: "0123456789abcdef",
  authorEmail: "a@example.com",
  parents: 1,
  signoffEmails: ["a@example.com"],
  ...over
});

test("a matching sign-off passes, ignoring case", () => {
  assert.deepEqual(dcoProblems([commit({ signoffEmails: ["A@Example.com"] })], human), []);
});

test("a missing sign-off fails", () => {
  assert.equal(dcoProblems([commit({ signoffEmails: [] })], human).length, 1);
});

test("a sign-off for someone else fails", () => {
  const [problem] = dcoProblems([commit({ signoffEmails: ["b@example.com"] })], human);
  assert.match(problem, /does not match the author/);
});

test("trailer values are parsed to their email", () => {
  assert.deepEqual(parseSignoffEmails(["A Person <A@Example.com>", "no email here", ""]), ["a@example.com"]);
});

test("a human-opened PR cannot exempt a commit with a spoofed [bot] author email", () => {
  const spoof = commit({ authorEmail: "evil[bot]@users.noreply.github.com", signoffEmails: [] });
  assert.equal(dcoProblems([spoof], human).length, 1);
  const spoofRenovate = commit({ authorEmail: RENOVATE_EMAIL, signoffEmails: [] });
  assert.equal(dcoProblems([spoofRenovate], human).length, 1);
});

test("a Bot-typed PR from a login that is not on the allowlist is not exempt", () => {
  const other = { login: "evil[bot]", type: "Bot" };
  assert.equal(
    dcoProblems([commit({ authorEmail: "1+evil[bot]@users.noreply.github.com", signoffEmails: [] })], other).length,
    1
  );
});

test("a user named renovate[bot] who is not typed Bot is not exempt", () => {
  const faker = { login: "renovate[bot]", type: "User" };
  assert.equal(dcoProblems([commit({ authorEmail: RENOVATE_EMAIL, signoffEmails: [] })], faker).length, 1);
});

test("a renovate-opened PR with the real renovate author passes unsigned", () => {
  assert.deepEqual(dcoProblems([commit({ authorEmail: RENOVATE_EMAIL, signoffEmails: [] })], renovate), []);
});

test("a renovate-opened PR still fails a commit by another email", () => {
  assert.equal(dcoProblems([commit({ signoffEmails: [] })], renovate).length, 1);
  const lookalike = commit({ authorEmail: `x${RENOVATE_EMAIL}`, signoffEmails: [] });
  assert.equal(dcoProblems([lookalike], renovate).length, 1);
  const suffixed = commit({ authorEmail: `${RENOVATE_EMAIL}.evil.com`, signoffEmails: [] });
  assert.equal(dcoProblems([suffixed], renovate).length, 1);
});

test("an empty range fails", () => {
  assert.match(dcoProblems([], human)[0], /no commits/);
});

test("a merge commit fails even when it is signed", () => {
  const [problem] = dcoProblems([commit({ parents: 2 })], human);
  assert.match(problem, /merge commits are not allowed, rebase/);
});

// Real repositories, to exercise the git plumbing the unit tests above bypass.
function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dco-"));
  try {
    const git = (...args) =>
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
        cwd: dir,
        encoding: "utf8"
      }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "f"), "1");
    git("add", "f");
    git("commit", "-q", "-s", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const script = resolve(import.meta.dirname, "../ci/dco-check.mjs");
    const run = (head, env = {}) => {
      const result = spawnSync("node", [script, base, head], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PR_AUTHOR_LOGIN: "someone", PR_AUTHOR_TYPE: "User", ...env }
      });
      return { status: result.status, output: result.stdout + result.stderr };
    };
    const edit = (value) => writeFileSync(join(dir, "f"), value);
    fn({ git, base, run, edit });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the script passes a signed commit and fails an unsigned one", () => {
  withRepo(({ git, run, edit }) => {
    edit("2");
    git("commit", "-q", "-a", "-s", "-m", "signed");
    assert.equal(run(git("rev-parse", "HEAD")).status, 0);
    edit("3");
    git("commit", "-q", "-a", "-m", "unsigned");
    assert.equal(run(git("rev-parse", "HEAD")).status, 1);
  });
});

test("Signed-off-by text that is not in the trailer block does not count", () => {
  withRepo(({ git, run, edit }) => {
    edit("2");
    git(
      "commit",
      "-q",
      "-a",
      "-m",
      "Fix\n\nSigned-off-by: T <t@example.com>\n\nMore prose after it, so it is not a trailer."
    );
    assert.equal(run(git("rev-parse", "HEAD")).status, 1);
    edit("3");
    git("commit", "-q", "-a", "-m", "Say Signed-off-by: T <t@example.com> in the middle of a line");
    assert.equal(run(git("rev-parse", "HEAD")).status, 1);
  });
});

test("an empty range fails with a clear message", () => {
  withRepo(({ base, run }) => {
    const { status, output } = run(base);
    assert.equal(status, 1);
    assert.match(output, /no commits/);
  });
});

test("a merge commit in the range fails", () => {
  withRepo(({ git, run, edit }) => {
    git("switch", "-q", "-c", "side");
    writeFileSync(join(git("rev-parse", "--show-toplevel"), "g"), "x");
    git("add", "g");
    git("commit", "-q", "-s", "-m", "side");
    git("switch", "-q", "main");
    edit("2");
    git("commit", "-q", "-a", "-s", "-m", "main");
    git("merge", "-q", "--no-ff", "-s", "ours", "-m", "merge", "side");
    const { status, output } = run(git("rev-parse", "HEAD"));
    assert.equal(status, 1);
    assert.match(output, /merge commits are not allowed, rebase/);
  });
});

test("the script reads the PR author from the environment, not the commit", () => {
  withRepo(({ git, run, edit }) => {
    edit("2");
    git("-c", "user.email=1+renovate[bot]@users.noreply.github.com", "commit", "-q", "-a", "-m", "bump");
    const head = git("rev-parse", "HEAD");
    const asUser = run(head);
    assert.equal(asUser.status, 1);
    const asBot = run(head, { PR_AUTHOR_LOGIN: "renovate[bot]", PR_AUTHOR_TYPE: "Bot" });
    assert.equal(asBot.status, 0, asBot.output);
  });
});
