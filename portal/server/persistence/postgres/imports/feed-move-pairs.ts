import type { ImportRecord } from "@openrhen/contracts";

/**
 * The first `relationships.feedMove` pair a commit would split, as a refusal message, or null. Records
 * sharing a pair id (a moved date's cancel and its replacement, or the reverse) must be committed
 * together: ticking only one half either cancels the meeting or duplicates it. `committing` says which
 * records this commit would write. Records with no `feedMove` are ignored, so any other source is inert.
 */
export function splitFeedMovePair<T extends Pick<ImportRecord, "relationships">>(
  records: readonly T[],
  committing: (record: T) => boolean
): string | null {
  const pairs = new Map<string, { in: number; out: number; size: number }>();
  for (const record of records) {
    const pairId = record.relationships?.feedMove;
    if (!pairId) continue;
    const tally = pairs.get(pairId) ?? { in: 0, out: 0, size: 0 };
    tally.size = Math.max(tally.size, Number(record.relationships?.feedMoveSize ?? 0));
    if (committing(record)) tally.in += 1;
    else tally.out += 1;
    pairs.set(pairId, tally);
  }
  for (const tally of pairs.values())
    // A pair that names its size (`feedMoveSize`) and is short of a record in the batch is a lone half: its partner was
    // never proposed, or was dropped, and writing the half alone loses the meeting or doubles it.
    if ((tally.in > 0 && tally.out > 0) || (tally.in + tally.out < tally.size && tally.in > 0))
      return "A moved meeting is two changes that go together. Select or unselect both, then commit again.";
  return null;
}
