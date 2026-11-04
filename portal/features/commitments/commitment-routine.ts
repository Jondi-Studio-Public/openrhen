import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { commitmentRepeatFallsOn, type CommitmentRepeat, type MonthAnchor } from "@openrhen/contracts";
import type { PortalState, StoredCommitment } from "@/state/portal-state";

/** Where a commitment's preparation routine comes from. Absent on a record means `inherit`. */
export type RoutineSource = NonNullable<StoredCommitment["routineSource"]>;

/**
 * The routine's provenance, resolved the same way the replan resolves it: `inherit` follows the
 * commitment's place to `defaultRoutinePresetId`, `preset` follows the pinned id, and the other two
 * resolve to nothing. Everything a chip needs to state where the steps came from — and, for
 * `inherit`, whether they came from anywhere at all.
 */
export interface RoutineProvenance {
  source: RoutineSource;
  /** The preset the routine actually resolves to, where one does. */
  presetId?: string;
  presetName?: string;
  /** The place an inherited routine reads its default from. */
  placeName?: string;
  /** The sentence the detail page shows. */
  label: string;
  /** The one word a row elsewhere has space for. */
  short: "inherited" | "pinned" | "customized" | "removed" | "none";
}

type PlaceLike = PortalState["conditionDefinitions"][number];
type PresetLike = PortalState["routinePresets"][number];

export function routineSourceOf(commitment: Pick<StoredCommitment, "routineSource">): RoutineSource {
  return commitment.routineSource ?? "inherit";
}

/**
 * Resolving here rather than reading a server-computed field is deliberate: the same portal state
 * already carries the place, its default and the presets, and a second copy of the answer would be
 * one more thing to keep in step with `syncInheritedRoutineSteps`.
 */
export function routineProvenance(
  commitment: Pick<StoredCommitment, "routineSource" | "routinePresetId" | "locationId">,
  // Defaulted rather than required: a caller reading a partial state — every state built before
  // places and presets existed — should get "no routine", not a crash on a missing list.
  conditionDefinitions: readonly PlaceLike[] = [],
  routinePresets: readonly PresetLike[] = []
): RoutineProvenance {
  const source = routineSourceOf(commitment);
  const presets = routinePresets ?? [];
  const preset = (id: string | undefined) => (id ? presets.find((item) => item.id === id) : undefined);
  if (source === "custom") return { source, label: "Customized", short: "customized" };
  if (source === "none") return { source, label: "Routine removed", short: "removed" };
  if (source === "preset") {
    const pinned = preset(commitment.routinePresetId);
    return pinned
      ? { source, presetId: pinned.id, presetName: pinned.name, label: `“${pinned.name}” · pinned`, short: "pinned" }
      : // A pinned preset that has been archived away still leaves the commitment pinned to it; say
        // so rather than quietly reading as "no routine", which is a different decision.
        { source, label: "Pinned routine is no longer available", short: "pinned" };
  }
  const place = conditionDefinitions.find((item) => item.kind === "location" && item.id === commitment.locationId);
  const inherited = preset(place?.defaultRoutinePresetId);
  if (!place || !inherited)
    return {
      source,
      ...(place ? { placeName: place.name } : {}),
      label: place ? "No routine (place has no default)" : "No routine (no place set)",
      short: "none"
    };
  return {
    source,
    presetId: inherited.id,
    presetName: inherited.name,
    placeName: place.name,
    label: `“${inherited.name}” · from ${place.name}`,
    short: "inherited"
  };
}

/** What the compact chip on a preparation row says, and the title it carries for the long version. */
export function routineChipText(provenance: RoutineProvenance): { text: string; title: string } {
  return { text: provenance.short, title: provenance.label };
}

function ordinal(n: number): string {
  const remainder10 = n % 10,
    remainder100 = n % 100;
  if (remainder10 === 1 && remainder100 !== 11) return `${n}st`;
  if (remainder10 === 2 && remainder100 !== 12) return `${n}nd`;
  if (remainder10 === 3 && remainder100 !== 13) return `${n}rd`;
  return `${n}th`;
}

function dayOfMonthOf(localDate: string): number {
  return Number(localDate.slice(8, 10));
}

/** Which occurrence (1-based) of its own weekday `localDate` is, within its own month. */
function weekdayOrdinalOf(localDate: string): number {
  return Math.floor((dayOfMonthOf(localDate) - 1) / 7) + 1;
}

function weekdayNameOf(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return dateTimeFormat(displayLocale(), { timeZone: "UTC", weekday: "long" }).format(
    new Date(Date.UTC(year, month - 1, day))
  );
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** What a monthly anchor means, read against the start date that gives it its value. */
function describeAnchor(anchor: MonthAnchor, startDate: string): string {
  switch (anchor) {
    case "day_of_month": {
      const day = dayOfMonthOf(startDate);
      return day > 28 ? `on the ${ordinal(day)} (months without it are skipped)` : `on the ${ordinal(day)}`;
    }
    case "last_day":
      return "on the last day of the month";
    case "nth_weekday":
      return `on the ${ordinal(weekdayOrdinalOf(startDate))} ${weekdayNameOf(startDate)}`;
    case "last_weekday":
      return `on the last ${weekdayNameOf(startDate)}`;
  }
}

/**
 * How often a series repeats, in the words the editor and catalog both use — the one renderer for
 * this fact; nowhere else spells it out inline.
 */
export function describeCadence(repeat: CommitmentRepeat, startDate: string): string {
  if (repeat.unit === "months") {
    const every = repeat.intervalMonths === 1 ? "every month" : `every ${repeat.intervalMonths} months`;
    return `${every}, ${describeAnchor(repeat.anchor, startDate)}`;
  }
  if (repeat.unit === "weeks") {
    const every = repeat.intervalWeeks === 1 ? "every week" : `every ${repeat.intervalWeeks} weeks`;
    const names = [...repeat.weekdays]
      .sort((left, right) => ((left + 6) % 7) - ((right + 6) % 7))
      .map((day) => WEEKDAY_NAMES[day]!);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    return `${every} on ${list}`;
  }
  if (repeat.intervalDays === 1) return "every day";
  if (repeat.intervalDays === 7) return "every week";
  if (repeat.intervalDays === 14) return "every fortnight";
  return `every ${repeat.intervalDays} days`;
}

/**
 * The monthly anchors the given start date can actually carry (invariant 2 of the design note: a
 * rule always falls on its own start date), each labelled with what it means for that date. Changing
 * the date changes which anchors are offered and how they read.
 */
export function monthAnchorOptions(startDate: string): { value: MonthAnchor; label: string }[] {
  if (!startDate) return [];
  const anchors: MonthAnchor[] = ["day_of_month", "last_day", "nth_weekday", "last_weekday"];
  return anchors
    .filter((anchor) => commitmentRepeatFallsOn({ unit: "months", intervalMonths: 1, anchor }, startDate, startDate))
    .map((anchor) => ({ value: anchor, label: describeAnchor(anchor, startDate) }));
}
