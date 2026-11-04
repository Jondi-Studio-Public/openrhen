import { AGENT_BASES, AGENT_PROPOSAL_EVIDENCE_MAX, type AgentBasis } from "./agent-proposals.js";

/**
 * The basis and evidence an agent attaches to a write, carried
 * as headers so every write route learns them without a change to its body. The evidence travels
 * percent-encoded because an HTTP header holds Latin-1 only and the person's words may not.
 */
export const BASIS_HEADER = "X-OpenRhen-Basis";
export const EVIDENCE_HEADER = "X-OpenRhen-Evidence";

export type ClaimParse<T> = { ok: true; value: T | undefined } | { ok: false; reason: string };

/** `stated`, `inferred` or `observed` (case and surrounding space ignored); blank or null means not supplied. */
export function parseBasis(raw: string | null | undefined): ClaimParse<AgentBasis> {
  const text = raw?.trim().toLowerCase();
  if (text === undefined || text === "") return { ok: true, value: undefined };
  return (AGENT_BASES as readonly string[]).includes(text)
    ? { ok: true, value: text as AgentBasis }
    : { ok: false, reason: `basis must be one of ${AGENT_BASES.join(", ")}.` };
}

/** Trimmed text of 1 to 300 characters with no control characters; blank or null means not supplied. */
export function parseEvidence(raw: string | null | undefined): ClaimParse<string> {
  const text = raw?.trim();
  if (text === undefined || text === "") return { ok: true, value: undefined };
  if (text.length > AGENT_PROPOSAL_EVIDENCE_MAX)
    return { ok: false, reason: `evidence must be at most ${AGENT_PROPOSAL_EVIDENCE_MAX} characters.` };
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)) return { ok: false, reason: "evidence must not contain control characters." };
  return { ok: true, value: text };
}

/** The header form of evidence: percent-encoded, so any text survives an HTTP header. */
export function encodeEvidenceHeader(evidence: string): string {
  return encodeURIComponent(evidence);
}

/** Reads an evidence header; a malformed encoding is a refusal, like any other bad value. */
export function parseEvidenceHeader(raw: string | null | undefined): ClaimParse<string> {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, reason: "evidence is not valid percent-encoding." };
  }
  return parseEvidence(decoded);
}
