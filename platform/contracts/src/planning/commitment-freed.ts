/**
 * "I'm free": whether a commitment occurrence has been released by the person and the release still
 * holds. `freedFrom` is `commitments.freed_from`; the occurrence is freed from that instant until its
 * effective end (the later of `endsAt` and any tracked overtime), and the stored statement is never
 * cleared by passing time, so after the end it simply stops mattering.
 *
 * Pure, over plain inputs, so the pulse recorder (which reads rows, not the engine's types) and the
 * engine's own `isFreedNow` agree on one rule without the engine importing the portal.
 */
export function commitmentFreedAt(input: {
  now: Date | string;
  freedFrom?: Date | string | null;
  effectiveEndsAt: Date | string;
}): boolean {
  if (!input.freedFrom) return false;
  const at = (value: Date | string) => (value instanceof Date ? value : new Date(value)).getTime();
  const now = at(input.now);
  return at(input.freedFrom) <= now && now < at(input.effectiveEndsAt);
}
