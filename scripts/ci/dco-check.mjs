#!/usr/bin/env node
// DCO check: every commit in <base>..<head> must carry a `Signed-off-by: Name <email>` trailer whose
// email is the commit author's (CONTRIBUTING.md). Used by .github/workflows/dco.yml.
//
//   PR_AUTHOR_LOGIN=<login> PR_AUTHOR_TYPE=<User|Bot> node scripts/ci/dco-check.mjs <base-sha> <head-sha>
//
// Merge commits and an empty range both fail: the ruleset is squash-and-linear only, and a range that
// lists nothing means the check looked at the wrong commits, which must never read as a pass.
//
// Bot exemption. A commit author's email is whatever the committer typed, so it proves nothing. The
// exemption therefore keys on the pull request's opener, which GitHub authenticates (PR_AUTHOR_LOGIN
// and PR_AUTHOR_TYPE come from github.event.pull_request.user), and only then also requires the commit's
// author email to be that app's exact noreply address.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// App logins whose pull requests need no sign-off, with the exact author email their commits carry.
// Extend by adding an entry; keep the pattern anchored.
export const BOT_EXEMPTIONS = new Map([["renovate[bot]", /^\d+\+renovate\[bot\]@users\.noreply\.github\.com$/]]);

/** The emails in `Name <email>` trailer values, lower-cased; values without an address are ignored. */
export function parseSignoffEmails(values) {
  return values.flatMap((value) => {
    const match = value.match(/<([^<>\s]+)>\s*$/);
    return match ? [match[1].toLowerCase()] : [];
  });
}

function exempt(commit, pr) {
  const pattern = pr.type === "Bot" ? BOT_EXEMPTIONS.get(pr.login) : undefined;
  return pattern !== undefined && pattern.test(commit.authorEmail);
}

/**
 * Problems with `commits` ({ sha, authorEmail, parents, signoffEmails }) on a pull request opened by
 * `pr` ({ login, type }); an empty list means the check passes.
 */
export function dcoProblems(commits, pr = { login: "", type: "" }) {
  if (commits.length === 0) return ["no commits in the range: refusing to pass a check that looked at nothing"];
  const problems = [];
  for (const commit of commits) {
    const short = commit.sha.slice(0, 12);
    if (commit.parents > 1) {
      problems.push(`${short}: merge commits are not allowed, rebase`);
      continue;
    }
    if (exempt(commit, pr)) continue;
    if (commit.signoffEmails.length === 0) problems.push(`${short}: no Signed-off-by line`);
    else if (!commit.signoffEmails.map((email) => email.toLowerCase()).includes(commit.authorEmail.toLowerCase())) {
      problems.push(`${short}: Signed-off-by does not match the author <${commit.authorEmail}>`);
    }
  }
  return problems;
}

function listCommits(base, head) {
  // %(trailers) reads only the final trailer block, so a sign-off quoted in prose does not count.
  // Unit, group and record separators cannot appear in these fields the way a newline can.
  const format = "%H%x1f%ae%x1f%P%x1f%(trailers:key=Signed-off-by,valueonly,separator=%x1d)%x1e";
  const out = execFileSync("git", ["log", `--format=${format}`, `${base}..${head}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha, authorEmail, parents, trailers] = record.split("\x1f");
      return {
        sha,
        authorEmail,
        parents: parents.split(" ").filter(Boolean).length,
        signoffEmails: parseSignoffEmails((trailers ?? "").split("\x1d"))
      };
    });
}

function main(argv, env) {
  const [base, head] = argv;
  if (!base || !head) {
    console.error("usage: node scripts/ci/dco-check.mjs <base-sha> <head-sha>");
    return 2;
  }
  const pr = { login: env.PR_AUTHOR_LOGIN ?? "", type: env.PR_AUTHOR_TYPE ?? "" };
  const commits = listCommits(base, head);
  const problems = dcoProblems(commits, pr);
  console.log(`DCO: checked ${commits.length} commit(s) in ${base.slice(0, 12)}..${head.slice(0, 12)}`);
  if (problems.length === 0) return 0;
  for (const problem of problems) console.error(`::error::${problem}`);
  console.error(
    "Add the line with `git commit -s --amend`, or `git rebase --signoff <base>` for several commits, then push again."
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
