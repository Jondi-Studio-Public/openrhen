import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { policyViolations, stripComment } from "../ci/workflow-policy.mjs";

// Public CI runs on GitHub-hosted runners only, with no trigger that hands untrusted input a token.
// The rules live in scripts/ci/workflow-policy.mjs; the first test runs them on the real workflows and
// the rest feed them bad fixtures, so a rule that stops matching fails here.
const dir = resolve(import.meta.dirname, "../../.github/workflows");
const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));

test("there are workflows to check", () => {
  assert.ok(files.includes("ci.yml"));
  assert.ok(files.includes("dco.yml"));
});

for (const name of files) {
  test(`${name} complies with the workflow policy`, () => {
    assert.deepEqual(policyViolations(readFileSync(join(dir, name), "utf8")), []);
  });
}

const PIN = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const wrap = (body, on = "on:\n  pull_request:\n") =>
  `name: T\n${on}permissions:\n  contents: read\njobs:\n  j:\n${body}`;
const ok = wrap("    runs-on: ubuntu-latest\n    steps:\n      - uses: " + PIN + "\n      - run: echo hi\n");
const failsWith = (text, pattern) => {
  const found = policyViolations(text);
  assert.ok(
    found.some((v) => pattern.test(v)),
    `expected ${pattern}, got ${JSON.stringify(found)}`
  );
};

test("the fixture baseline is clean", () => {
  assert.deepEqual(policyViolations(ok), []);
});

test("a self-hosted label fails, in a list or a matrix", () => {
  failsWith(ok.replace("ubuntu-latest", "[self-hosted, linux, linux-ci]"), /self-hosted/);
  failsWith(ok.replace("ubuntu-latest", "mac-ci"), /self-hosted/);
  failsWith(ok.replace("ubuntu-latest", "macos-latest"), /runs-on macos-latest/);
  failsWith(
    wrap("    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner: macos-latest\n"),
    /matrix runner/
  );
});

test("a multi-line runs-on with group: or labels: fails", () => {
  failsWith(wrap("    runs-on:\n      group: big-runners\n    steps: []\n"), /mapping or list/);
  failsWith(wrap("    runs-on:\n      labels: [x]\n    steps: []\n"), /mapping or list/);
});

for (const trigger of [
  "pull_request_target",
  "workflow_run",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment"
]) {
  test(`trigger ${trigger} fails`, () => {
    failsWith(
      wrap("    runs-on: ubuntu-latest\n    steps: []\n", `on:\n  ${trigger}:\n`),
      new RegExp(`trigger ${trigger}`)
    );
    failsWith(
      wrap("    runs-on: ubuntu-latest\n    steps: []\n", `on: [push, ${trigger}]\n`),
      new RegExp(`trigger ${trigger}`)
    );
  });
}

test("plain pull_request is not mistaken for pull_request_review", () => {
  assert.deepEqual(policyViolations(ok), []);
});

for (const expression of [
  "github.event.pull_request.title",
  "github.head_ref",
  "github.ref_name",
  "github.event.comment.body"
]) {
  test(`\${{ ${expression} }} inside a run block fails`, () => {
    failsWith(ok.replace("run: echo hi", `run: |\n          echo "\${{ ${expression} }}"`), /untrusted github context/);
    failsWith(ok.replace("run: echo hi", `run: echo \${{ ${expression} }}`), /untrusted github context/);
  });
}

test("the same expression through env: is allowed", () => {
  const text = ok.replace(
    "      - run: echo hi\n",
    '      - env:\n          TITLE: ${{ github.event.pull_request.title }}\n        run: echo "$TITLE"\n'
  );
  assert.deepEqual(policyViolations(text), []);
});

test("a # inside a quoted string is kept, so a label hidden after it is still seen", () => {
  assert.equal(stripComment('x: "a # b" # real comment'), 'x: "a # b" ');
  failsWith(ok.replace("runs-on: ubuntu-latest", 'runs-on: "x # y" self-hosted'), /self-hosted/);
  assert.equal(stripComment("a: b # c"), "a: b ");
  assert.equal(stripComment("a: b#c"), "a: b#c");
});

test("a comment that merely mentions a forbidden word is ignored", () => {
  assert.deepEqual(policyViolations(ok.replace("jobs:", "# never self-hosted, never pull_request_target\njobs:")), []);
});

test("secrets other than GITHUB_TOKEN fail", () => {
  failsWith(ok.replace("echo hi", "echo ${{ secrets.NPM_TOKEN }}"), /secrets\.NPM_TOKEN/);
});

test("an unpinned action fails", () => {
  failsWith(ok.replace(PIN, "actions/checkout@v7"), /not pinned/);
  failsWith(ok.replace("# v7.0.1", ""), /not pinned/);
  failsWith(ok.replace("actions/checkout@", "pnpm/action-setup@"), /not owned by GitHub/);
});

test("a workflow without read-only top-level permissions fails", () => {
  failsWith(ok.replace("permissions:\n  contents: read\n", ""), /permissions/);
});
