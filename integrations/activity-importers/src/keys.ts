import { createHash } from "node:crypto";

/**
 * The event key: a sha1 of the stable fields of the source row, so importing the same export again is a no-op.
 * Parts are joined with a unit separator, which cannot appear in the text fields hashed here, so ("ab", "c") and
 * ("a", "bc") never collide.
 */
export function eventKey(...parts: (string | number)[]): string {
  const hash = createHash("sha1");
  parts.forEach((part, index) => {
    if (index > 0) hash.update("\u001f");
    hash.update(String(part));
  });
  return hash.digest("hex");
}

/**
 * Numbers repeats of an identical row (`dup_index`), so two real visits at the same microsecond both survive while
 * a second import of the same file still produces the same keys. Exports are written in time order, so repeats are
 * adjacent; the table is cleared past a bound so a huge file cannot hold all its keys in memory.
 */
export class DupCounter {
  private readonly counts = new Map<string, number>();
  constructor(private readonly limit = 200_000) {}

  next(identity: string): number {
    if (this.counts.size >= this.limit) this.counts.clear();
    const seen = this.counts.get(identity) ?? 0;
    this.counts.set(identity, seen + 1);
    return seen;
  }
}
