// Policy for the workflow files in a public repository, as pure text checks so the tests can feed them
// bad fixtures. `policyViolations(text)` returns one string per violation; empty means compliant.
//
// Why each rule: runners must be GitHub-hosted (a public repo must not run outside code on anyone's own
// machine); the listed triggers run with a token or secrets in the context of untrusted input;
// `github.event.*`, `head_ref` and `ref_name` hold attacker-chosen text (titles, branch names) and must
// reach a shell through `env:`, never by being pasted into a `run:` script; actions are pinned by sha.

export const HOSTED_RUNNERS = ["ubuntu-latest", "ubuntu-24.04-arm"];
export const FORBIDDEN_TRIGGERS = [
  "pull_request_target",
  "workflow_run",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment"
];
const UNTRUSTED_CONTEXT = /\$\{\{[^}]*\b(?:github\.event|github\.head_ref|github\.ref_name)\b/;

/** `line` without a trailing YAML comment; a `#` inside a quoted string is kept. */
export function stripComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** The text of each `run:` step, with the line number it starts on (inline value or block scalar). */
export function runBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) continue;
    const keyColumn = lines[i].indexOf("run:");
    let body = /^[|>][+-]?\d*$/.test(match[2].trim()) ? "" : match[2];
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === "" || lines[j].search(/\S/) > keyColumn)) {
      body += `\n${lines[j]}`;
      j += 1;
    }
    blocks.push({ n: i + 1, body });
    i = j - 1;
  }
  return blocks;
}

export function policyViolations(text) {
  const out = [];
  const raw = text.split("\n");
  const lines = raw.map(stripComment);
  lines.forEach((line, index) => {
    const n = index + 1;
    if (/self-hosted|linux-ci|mac-ci/i.test(line)) out.push(`${n}: names a self-hosted runner label`);
    for (const trigger of FORBIDDEN_TRIGGERS)
      if (new RegExp(`\\b${trigger}\\b`).test(line)) out.push(`${n}: trigger ${trigger}`);
    const runsOn = line.match(/^\s*runs-on:\s*(.*?)\s*$/);
    if (runsOn) {
      if (runsOn[1] === "") out.push(`${n}: runs-on as a mapping or list (group:/labels:) is not allowed`);
      else if (!HOSTED_RUNNERS.includes(runsOn[1]) && runsOn[1] !== "${{ matrix.runner }}")
        out.push(`${n}: runs-on ${runsOn[1]}`);
    }
    const runner = line.match(/^\s*-?\s*runner:\s*(.+?)\s*$/);
    if (runner && !HOSTED_RUNNERS.includes(runner[1])) out.push(`${n}: matrix runner ${runner[1]}`);
    for (const secret of line.matchAll(/secrets\.([A-Za-z0-9_]+)/g))
      if (secret[1] !== "GITHUB_TOKEN") out.push(`${n}: secrets.${secret[1]}`);
  });
  for (const { n, body } of runBlocks(lines))
    if (UNTRUSTED_CONTEXT.test(body))
      out.push(`${n}: run: script interpolates untrusted github context; pass it through env:`);
  raw.forEach((line, index) => {
    const uses = line.match(/^\s*-?\s*uses:\s*(\S+)(.*)$/);
    if (!uses || uses[1].startsWith("./")) return;
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(uses[1]) || !/^\s*#\s*v\d+\.\d+\.\d+\s*$/.test(uses[2]))
      out.push(`${index + 1}: action not pinned to a sha with a version comment: ${line.trim()}`);
  });
  if (!/^permissions:\n {2}contents: read\n/m.test(text)) out.push("missing top-level permissions: contents: read");
  return out;
}
