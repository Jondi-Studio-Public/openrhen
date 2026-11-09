# Reconcile replay harness

Status: core harness implemented (golden cases, scoring, baseline); the seeded generator follows. Owns: the replay harness in `platform/contracts/src/planning/replay/`, its fixtures in `platform/contracts/test/replay/`, and the `Reconciler` interface.

The replay harness scores what happens after a message has been read into facts: does it change the plan, restate something already on it, raise a question, do nothing, or fail to resolve. It runs in memory with no database or network, inside the contracts unit run.

## The unit under test

`Reconciler = (input, { chooser }) => outcome`. The input is a plan (commitments, actions and projects with deadlines, contacts, remembered aliases, open asks) and one message with at most one fact. The outcome is one of five end states: `applied` (a create, update or cancel, with a target), `duplicate` (it restates a record), `asked` (held for a question), `no_effect` (with a reason) or `unresolved` (with a reason). It also carries up to five `candidates` (id, rank, score, lane), a `tie` flag, `usedChooser` and the chooser's pick. `replay-reference.ts` is today's behaviour behind that interface, including first-wins on equal matches; the real reconciler replaces it without touching the cases or the scoring.

A chooser sees a quote and at most five cards and answers `cN`, `none` or `unsure`. Every case runs on the deterministic path (a chooser that must not be called) and on three stub paths: `oracle`, `adversarial` and `noisy`. A real model never runs in CI.

## Cases and privacy

`golden.json` holds hand-written cases: an `id`, `tags`, the `input`, and a `gold` (end state, target, acceptable targets, op, reason, `mustNot`, `deny`). Names are fictional, addresses are `@example.test`, and the source is `message-test`. `lexicon.json` lists the only words a title, quote or name may use; the guard test fails on any other word, any other address, or secret-shaped text, so a pasted real message cannot merge. Add a word to the lexicon only for a neutral one.

A labelled set kept outside git (reviewed real cases) uses the same case format. `scripts/test/replay-case-files.mjs` reads a directory of `*.json` files (nothing when it is unset or missing; a directory inside a git checkout is refused) and `parseExternalCases` turns them into cases, so such a set needs no code change. The committed suite does not depend on it.

## Scoring and the baseline

Scores are overall, per tag and per plan size: a confusion matrix over end states, applied precision, false-merge, wrong-create and wrong-duplicate rates, Deny rate and Confirm accuracy, tie rate and tie resolution, recall at five, the share resolved without a chooser, questions per 100 messages and the unresolved share, each with a count pair that a Wilson interval can be drawn from.

`baseline.json` is the last accepted result. The suite fails when applied precision, recall at five or the no-chooser share falls, and when any recorded figure differs, so a change of behaviour always shows in the baseline diff; a deliberate change updates the baseline in the same commit with the reason in the message. Two invariants are never ratcheted: nothing resolves to one target on a tied top rank without a chooser, and nothing does what a case's `mustNot` forbids. The baseline lists the cases that break them today (first-wins on ties, moved deadlines read as new); that list may only shrink.
