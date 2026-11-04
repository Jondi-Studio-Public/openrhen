import { buildInfo } from "./build-info.js";

const UNKNOWN = new Set(["", "dev", "unknown"]);

/** Whether two commits name the same build; the CLI bakes a short sha and the portal a longer one, so a prefix match either way counts. */
export function sameCommit(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return left.startsWith(right) || right.startsWith(left);
}

/** True only when both sides are real commits and they differ. */
export function isBehind(cliCommit: string, serverCommit: string | null | undefined): boolean {
  if (!serverCommit || UNKNOWN.has(serverCommit.trim().toLowerCase())) return false;
  if (UNKNOWN.has(cliCommit.trim().toLowerCase())) return false;
  return !sameCommit(cliCommit, serverCommit);
}

/** The one-line note printed to stderr (and surfaced to MCP agents as "Notes from the CLI") when the bundle is stale. */
export function staleNote(
  serverCommit: string | null | undefined,
  cliCommit: string = buildInfo.commit
): string | null {
  return isBehind(cliCommit, serverCommit)
    ? `Note: this CLI build (${cliCommit}) differs from the portal (${serverCommit}). Run \`rhen self-update\` to update.`
    : null;
}
