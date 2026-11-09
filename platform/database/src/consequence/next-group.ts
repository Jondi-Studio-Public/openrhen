/**
 * Picks the next group of items to compare (comparison-consequence-ranking design, 3.6). Pure and deterministic: the
 * same candidates, history and clock always give the same group.
 *
 * Within one pool: the item with the highest variance, plus its three nearest neighbours by current value. Projects
 * compare with projects; actions only with siblings of the same project (their `cohort`). A pair asked in the last 30
 * days is never repeated: a neighbour that would make a cooling pair with anyone already in the group is skipped, and
 * an anchor that cannot gather even one neighbour gives way to the next-highest variance. Ties break on the item id.
 *
 * Private items (effective privacy, inherited down from the area) are skipped when the group is for an agent-facing
 * use, and the result says whether any private item is in it, so a caller that did not ask for agent-facing output can
 * still decide what to show.
 */

export const GROUP_SIZE = 4;
export const PAIR_COOLDOWN_DAYS = 30;

export interface GroupCandidate {
  id: string;
  /** The value ranking currently uses for this item (refined when valid, else its stars). */
  value: number;
  /** Posterior variance from the fit; larger means a better candidate to ask about. */
  variance: number;
  /** Who it may be compared with: one constant for projects, the parent project id for actions. */
  cohort: string;
  private: boolean;
}

export interface AskedGroup {
  itemIds: readonly string[];
  askedAt: Date;
}

export interface NextGroupOptions {
  now: Date;
  /** Groups already issued or answered, newest or oldest first; only those inside the cool-down matter. */
  recentGroups: readonly AskedGroup[];
  /** Skip private items. */
  agentFacing?: boolean;
  size?: number;
  cooldownDays?: number;
}

export interface NextGroup {
  /** The highest-variance item the group was built around. */
  anchorId: string;
  /** Anchor first, then neighbours nearest first. */
  itemIds: string[];
  containsPrivate: boolean;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The pairs asked inside the cool-down window, as a set of unordered pair keys. */
export function coolingPairs(recentGroups: readonly AskedGroup[], now: Date, cooldownDays = PAIR_COOLDOWN_DAYS) {
  const since = now.getTime() - cooldownDays * 86_400_000;
  const pairs = new Set<string>();
  for (const group of recentGroups) {
    if (group.askedAt.getTime() <= since) continue;
    for (let i = 0; i < group.itemIds.length; i += 1)
      for (let j = i + 1; j < group.itemIds.length; j += 1) pairs.add(pairKey(group.itemIds[i]!, group.itemIds[j]!));
  }
  return pairs;
}

export function nextConsequenceGroup(
  candidates: readonly GroupCandidate[],
  options: NextGroupOptions
): NextGroup | null {
  const size = Math.max(2, Math.min(GROUP_SIZE, options.size ?? GROUP_SIZE));
  const cooling = coolingPairs(options.recentGroups, options.now, options.cooldownDays);
  const seen = new Set<string>();
  const eligible = [...candidates]
    .filter((item) => Number.isFinite(item.value) && Number.isFinite(item.variance))
    .filter((item) => !(options.agentFacing && item.private))
    .sort(byId)
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));

  const anchors = [...eligible].sort((a, b) => b.variance - a.variance || byId(a, b));
  for (const anchor of anchors) {
    const neighbours = eligible
      .filter((item) => item.id !== anchor.id && item.cohort === anchor.cohort)
      .sort((a, b) => Math.abs(a.value - anchor.value) - Math.abs(b.value - anchor.value) || byId(a, b));
    const group = [anchor];
    for (const neighbour of neighbours) {
      if (group.length === size) break;
      if (group.some((member) => cooling.has(pairKey(member.id, neighbour.id)))) continue;
      group.push(neighbour);
    }
    if (group.length >= 2)
      return {
        anchorId: anchor.id,
        itemIds: group.map((item) => item.id),
        containsPrivate: group.some((i) => i.private)
      };
  }
  return null;
}
