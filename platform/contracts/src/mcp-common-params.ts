/**
 * Arguments every write shares, described once here in plain terms: no `--flag`, no exit code. The CLI writes this text
 * onto every mutating tool's matching argument, and a generated tool file for an extension refers to it by name instead
 * of copying it, so a wording change here reaches the extension's tools without regenerating them.
 * Its keys are known, so a generated file can index it by a literal key under `noUncheckedIndexedAccess`.
 */
export const MCP_COMMON_PARAMS = Object.freeze({
  "command-id": "Optional: omit and the server makes one. Resend the SAME only after a timeout.",
  basis:
    "stated (owner's words go in evidence), observed (read from mail, page or file), inferred (your guess; default).",
  evidence: "Owner's words; required with basis stated.",
  "dry-run": "true: preview only; checks shape, not ids, evidence or scopes.",
  "expected-version": "The record's `version` from rhen_show or rhen_list; a changed record is refused with a conflict."
} as const satisfies Record<string, string>);
