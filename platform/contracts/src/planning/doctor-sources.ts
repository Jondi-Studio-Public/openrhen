/**
 * Doctor's data-source checks (design 4.7): a source that has gone quiet, a device that has gone silent, a token that
 * was never used, a registry entry whose health cannot be read, rows collected that nothing uses, and a file import
 * that skipped rows. Pure over a plain slice, like the other `doctor-*.ts` files; the portal reader builds the slice
 * from the data-flow health reader and the registry's graph. Status only: no error body, address or file path.
 *
 * Calendar and other sync-run sources keep `sync_late` and `sync_failing` exactly as they were (`keepsSyncChecks`), so
 * nothing here replaces them and a source never raises two items for one problem.
 */
import { processingLine, type HeartbeatRead, type ProcessingReport } from "../data-flow/coverage.js";
import type { ThresholdInUse } from "../data-flow/health.js";
import { RHYTHM_ABANDONED_FACTOR, RHYTHM_CHANGED_FACTOR, formatSpan } from "../data-flow/rhythm.js";
import type { DoctorItem } from "./doctor.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A learned device threshold (arrivals, not coverage) may make an item blocking only when it rests on this many days of arrivals. */
export const DOCTOR_LEARNED_BLOCKING_DAYS = 30;
/** A device is only reasoned about as a whole when at least this many of its feeds have ever been seen. */
export const DOCTOR_DEVICE_MIN_FEEDS = 2;
/** An import run older than this no longer raises a "skipped rows" item. */
export const DOCTOR_IMPORT_REVIEW_DAYS = 30;

/** Every check this file raises; when the probes cannot be read, each is listed as not run. */
export const DOCTOR_SOURCE_CHECKS = [
  "source_late",
  "source_silent",
  "device_silent",
  "probe_unresolved",
  "token_not_bound",
  "sources_collecting_unused",
  "import_needs_review"
] as const;

export type DoctorSourceFreshness = "fresh" | "late" | "stale" | "never" | "failing" | "n/a" | "probe_unresolved";

export interface DoctorSourceInput {
  id: string;
  /** The registry's plain name for the source, for example "Streaming history". */
  name: string;
  /** Calendar and other sync-provider sources, which `sync_late` and `sync_failing` already judge. */
  keepsSyncChecks: boolean;
  /** The name `rhen import` takes for this source, when it is a file import. */
  activitySource?: string;
  /** The device this source rolls up into, when it has one. */
  device?: string;
  /** The source's reach includes the planning engine. */
  engineReads: boolean;
  /** Messages from this source can change the plan: a stale one is blocking, and a source that is behind makes the plan's inputs incomplete. */
  changesPlan?: true;
  /** The source reports how far it has been read; `lastSuccessAt` is then `coveredTo`, not the newest arrival. */
  coverage?: {
    coveredTo: string | null;
    heartbeat: HeartbeatRead | null;
    holes14d: number;
    /** Each scope's high-water mark, so an item can name the one holding the source back. */
    scopes?: { scope: string | null; coveredTo: string; retired?: true }[];
  };
  /** The source can take messages and so should report coverage, whether or not it changes the plan yet. */
  messageSource?: true;
  /** Evidence the source is in use: a row, a run or a use of its token. */
  configured: boolean;
  /** The source's own token exists and is live, whether or not it has been used. */
  credentialPresent?: boolean;
  freshness: DoctorSourceFreshness;
  lastSuccessAt: string | null;
  threshold: ThresholdInUse | null;
  /** A coverage source with fewer than 2 gaps and nothing declared: no rhythm yet, no threshold, nothing is late. */
  noRhythm?: { updates: number; gaps: number };
  /** Kinds of this source that stopped arriving on their own learned rhythm while the source as a whole did not. */
  lateKinds?: { kind: string; lastAt: string; warnHours: number }[];
  /** Rows that arrived in the last 7 days. */
  count7d?: number;
  /** Collected, and what it collects reaches no use. Sources nothing sends are not counted. */
  reachEmpty: boolean;
  /** This source's health is the phone's location ping, which `location_ping_silent` also judges. */
  phonePing?: boolean;
  /** The newest file-import run for this source, within the last 30 days. */
  latestImport?: { status: string; at: string; skipped: number } | null;
}

export interface DoctorSourceIssue {
  code: "probe_unresolved" | "token_not_bound";
  entryId: string;
  tier: "degrading" | "tidy";
  title: string;
  next: string;
  /** `person` when only the owner can act (mint a token, say); `agent` (the default) when a tool call can. */
  who?: "agent" | "person";
}

export interface DoctorDeviceInput {
  id: string;
  entries: string[];
  lastSeenAt: string | null;
  lastSeenFrom: string | null;
}

export interface DoctorSourcesSlice {
  sources: DoctorSourceInput[];
  devices: DoctorDeviceInput[];
  issues: DoctorSourceIssue[];
  /** Entries that collect and reach nothing. */
  unused: number;
  /** Entries accepted but sent by nothing. */
  nothingSends: number;
  /** Messages collected against messages that reached an end state, per message source; absent when none could be read. */
  processing?: ProcessingReport[];
  /** Set when the probes could not be read at all: the source checks are then listed as not run. The cause stays in the server log. */
  unavailable?: true;
}

export interface DoctorSourceCounts {
  late: number;
  deviceSilent: number;
  collectedUnused: number;
  nothingSends: number;
  /** "4 late · 1 device silent · 11 collected, unused · 5 accepted, nothing sends"; null when all are zero. */
  line: string | null;
}

export function sourceCountsLine(
  counts: Pick<DoctorSourceCounts, "late" | "deviceSilent" | "collectedUnused" | "nothingSends">
): string | null {
  const parts = [
    counts.late > 0 ? `${counts.late} late` : "",
    counts.deviceSilent > 0 ? `${counts.deviceSilent} ${counts.deviceSilent === 1 ? "device" : "devices"} silent` : "",
    counts.collectedUnused > 0 ? `${counts.collectedUnused} collected, unused` : "",
    counts.nothingSends > 0 ? `${counts.nothingSends} accepted, nothing sends` : ""
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function ms(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

function age(from: number, now: number): string {
  const hours = Math.max(0, Math.round((now - from) / HOUR_MS));
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

const number = (value: number) => value.toLocaleString("en-US");

const isLate = (source: DoctorSourceInput) => source.freshness === "late" || source.freshness === "stale";
const pastThreshold = (source: DoctorSourceInput) => source.configured && source.threshold !== null && isLate(source);

/**
 * Whether a threshold is real enough to block on. The origins that may are listed: the owner's expectation, the collector's
 * declared cadence, a coverage source's own rhythm once real (it carries its gaps; a provisional one has its own origin and
 * never blocks), a learned device threshold with a full month of arrivals, and the entry's own, connection's or default numbers.
 */
const statedThreshold = (source: DoctorSourceInput) => {
  const threshold = source.threshold;
  if (threshold === null) return false;
  switch (threshold.from) {
    case "owner":
    case "collector":
      return true;
    case "learned":
      return threshold.gaps !== undefined || (threshold.days ?? 0) >= DOCTOR_LEARNED_BLOCKING_DAYS;
    case "provisional":
      return false;
    default:
      return true;
  }
};

/** A coverage source more than 3 x its stale limit behind has probably been retired: it stops blocking and says so. */
const abandoned = (source: DoctorSourceInput, now: number) => {
  const last = ms(source.lastSuccessAt);
  const stale = source.threshold?.errorHours;
  return (
    source.coverage !== undefined &&
    statedThreshold(source) &&
    stale !== undefined &&
    stale !== null &&
    last !== undefined &&
    (now - last) / HOUR_MS > RHYTHM_ABANDONED_FACTOR * stale
  );
};

/** A source that just resumed after a gap longer than twice its limit is not blocking until 1.5 x that gap has passed. */
const awaitingConfirmation = (source: DoctorSourceInput, now: number) => {
  const gap = source.threshold?.rhythmChanged?.lastGapHours;
  const last = ms(source.lastSuccessAt);
  return gap !== undefined && last !== undefined && (now - last) / HOUR_MS <= RHYTHM_CHANGED_FACTOR * gap;
};

/**
 * Whether a late source's own item is blocking: past its error threshold, read by the engine or able to change the plan
 * (a message source), on a real limit, not retired and not waiting to confirm a changed rhythm.
 */
const feedsPlan = (source: DoctorSourceInput) => source.engineReads || source.changesPlan === true;
const blockingLate = (source: DoctorSourceInput, now: number) =>
  pastThreshold(source) &&
  source.freshness === "stale" &&
  feedsPlan(source) &&
  statedThreshold(source) &&
  !abandoned(source, now) &&
  !awaitingConfirmation(source, now);

/** The date and time, to the minute, in UTC, for text an agent or person reads. */
const stamp = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** What a provisional limit still needs, in words: "3 more updates", "20 h more history" or both. */
function moreText(threshold: ThresholdInUse): string {
  const more = threshold.provisional;
  const parts = [
    more !== undefined && more.moreUpdates > 0
      ? `${more.moreUpdates} more ${more.moreUpdates === 1 ? "update" : "updates"}`
      : "",
    more !== undefined && more.moreHours > 0 ? `${formatSpan(more.moreHours * HOUR_MS)} more history` : ""
  ].filter(Boolean);
  return `becomes final after ${parts.length > 0 ? parts.join(" and ") : "its next update"}`;
}

/** The next step for a source that has stopped for good; only the owner can remove a token or make a collector send. */
const RETIRED_NEXT = "Ask the owner to remove its token (`rhen agent-token list` shows it) or to make it send once.";

/** The owner's way to say how often a source is expected; the agent never sets it. No number is suggested. */
const askOwnerExpectation = (activitySource: string) =>
  `Ask the owner to set how often they expect this source if it is simply slower than it looks (owner session: \`PUT /api/activity-sources/${activitySource}\` with \`{"expectedEveryMinutes": MINUTES}\`, MINUTES a whole number from 5 to 129600; \`null\` clears it).`;

/** "its usual rhythm of one update every 1 d", for the title of an item on a source with a rhythm; empty when none is known. */
function rhythmClause(threshold: ThresholdInUse | null): string {
  if (threshold?.usualMinutes === undefined) return "";
  const every = formatSpan(threshold.usualMinutes * 60_000);
  return threshold.from === "owner"
    ? ` the rhythm the owner expects, one update every ${every}`
    : ` its usual rhythm of one update every ${every}`;
}

/** The sentence that says where a coverage source's late and stale limits come from; null for any other origin. */
function limitRule(source: DoctorSourceInput): string | null {
  const threshold = source.threshold;
  if (threshold === null || threshold.errorHours === null) return null;
  const limits = `late after ${formatSpan(threshold.warnHours * HOUR_MS)} and stale after ${formatSpan(threshold.errorHours * HOUR_MS)}`;
  switch (threshold.from) {
    case "owner":
      return `Its limit comes from the owner's expectation of one update every ${formatSpan((threshold.expectedEveryMinutes ?? 0) * 60_000)}: ${limits}.`;
    case "provisional":
      return `Its limit is provisional (${limits}): judged on ${threshold.gaps ?? 0} gaps; ${moreText(threshold)}. Nothing blocks on it until then.`;
    case "learned":
      if (threshold.gaps === undefined) return null;
      return `It usually updates every ${formatSpan((threshold.usualMinutes ?? 0) * 60_000)}; ${limits} (learned from its own posts over ${threshold.gaps} gaps).${threshold.declaredWarnHours !== undefined ? ` Its collector declares late after ${formatSpan(threshold.declaredWarnHours * HOUR_MS)}.` : ""}`;
    case "collector": {
      const observed = threshold.observedWarnHours;
      const compare =
        observed === undefined
          ? ""
          : observed > threshold.warnHours
            ? ` Observed slower than declared: its own posts would allow late after ${formatSpan(observed * HOUR_MS)}, but blocking holds to the declared limit.`
            : ` Observed faster than declared: its own posts would give late after ${formatSpan(observed * HOUR_MS)}.`;
      return `Its collector declares a cadence: ${limits}.${compare}`;
    }
    default:
      return null;
  }
}

export interface PlanInputsBehind {
  source: string;
  name: string;
  /** Read up to here; null when nothing has been reported as read. */
  coveredTo: string | null;
  /** `unchecked`: the source is in use but reports nothing that says how far it has been read (no coverage, no stated threshold, or its probe cannot be read). */
  state: "late" | "stale" | "failing" | "never" | "unchecked";
}

/** What the plan is built from, in one statement: whether every source that can change it is read up to date. */
export interface PlanInputs {
  /** False when any source that can change the plan is late, stale, failing or has never reported a read. */
  complete: boolean;
  behind: PlanInputsBehind[];
  /** The sentence to show beside the plan; null when complete. Names the exact next call. */
  sentence: string | null;
  /** Message sources this statement does not cover (they report no coverage, or are not marked as changing the plan). Null when none. */
  note: string | null;
}

/**
 * Whether the plan's inputs are complete. Only sources flagged `changesPlan` count, and only once there is evidence they
 * are in use (a row, a heartbeat or a live token), so a source nobody set up is not a gap. The engine is not told: this is
 * the portal's statement over the doctor's own slice.
 */
export function planInputs(slice: DoctorSourcesSlice, now?: number): PlanInputs {
  const behind: PlanInputsBehind[] = [];
  const quiet: DoctorSourceInput[] = [];
  const provisional: DoctorSourceInput[] = [];
  const retired: DoctorSourceInput[] = [];
  for (const source of slice.sources) {
    if (source.changesPlan !== true || !(source.configured || source.credentialPresent === true)) continue;
    const isLate = source.freshness === "late" || source.freshness === "stale";
    // No rhythm yet: informational. Nothing is late, so the plan is not behind on it; the note says so.
    if (source.noRhythm !== undefined && source.freshness === "n/a") {
      quiet.push(source);
      continue;
    }
    if (isLate && source.threshold?.from === "provisional") {
      provisional.push(source);
      continue;
    }
    if (isLate && now !== undefined && abandoned(source, now)) {
      retired.push(source);
      continue;
    }
    const state: PlanInputsBehind["state"] | undefined =
      source.freshness === "late" ||
      source.freshness === "stale" ||
      source.freshness === "failing" ||
      source.freshness === "never"
        ? source.freshness
        : source.freshness === "n/a" || source.freshness === "probe_unresolved"
          ? "unchecked"
          : undefined;
    if (state === undefined) continue;
    behind.push({
      source: source.id,
      name: source.name,
      coveredTo: source.coverage ? source.coverage.coveredTo : state === "unchecked" ? null : source.lastSuccessAt,
      state
    });
  }
  const uncounted = slice.sources.filter(
    (source) =>
      source.messageSource === true &&
      source.changesPlan !== true &&
      !source.keepsSyncChecks &&
      (source.configured || source.credentialPresent === true)
  );
  const parts: string[] = [];
  if (uncounted.length > 0)
    parts.push(
      `Not covered by this statement: ${uncounted.map((source) => source.name).join(", ")}. ${uncounted.length === 1 ? "It sends" : "They send"} messages but ${uncounted.length === 1 ? "is" : "are"} not yet judged by how far ${uncounted.length === 1 ? "it is" : "they are"} read, so the plan can be behind on ${uncounted.length === 1 ? "it" : "them"} unseen. The collector must post a coverage row (docs/operations/posting-messages.md, section 5) and the source be marked as changing the plan.`
    );
  if (quiet.length > 0)
    parts.push(
      `${quiet.map((source) => `${source.name} reports ${source.noRhythm!.updates} ${source.noRhythm!.updates === 1 ? "update" : "updates"} and has no rhythm yet`).join(", ")}; nothing is judged late until ${quiet.length === 1 ? "it has" : "they have"} two gaps between updates. Run \`rhen sources ${quiet[0]!.id}\` to see ${quiet.length === 1 ? "it" : "each"}.`
    );
  if (provisional.length > 0)
    parts.push(
      `${provisional.map((source) => `${source.name} is behind on a limit judged on ${source.threshold!.gaps ?? 0} gaps (${moreText(source.threshold!)})`).join(", ")}, so ${provisional.length === 1 ? "it is" : "they are"} not counted as behind yet. Run \`rhen sources ${provisional[0]!.id}\`.`
    );
  if (retired.length > 0)
    parts.push(
      `${retired.map((source) => source.name).join(", ")} ${retired.length === 1 ? "has" : "have"} probably been retired (more than ${RHYTHM_ABANDONED_FACTOR} x ${retired.length === 1 ? "its" : "their"} stale limit behind) and no longer ${retired.length === 1 ? "counts" : "count"} as behind. ${RETIRED_NEXT}`
    );
  const note = parts.length > 0 ? parts.join(" ") : null;
  if (behind.length === 0) return { complete: true, behind, sentence: null, note };
  const read = behind
    .filter((item) => item.coveredTo !== null)
    .sort((a, b) => a.coveredTo!.localeCompare(b.coveredTo!));
  const count = `${behind.length} ${behind.length === 1 ? "source" : "sources"} behind`;
  const first = behind[0]!;
  const unchecked = behind.filter((item) => item.state === "unchecked");
  const next =
    `Run \`rhen sources ${first.source}\` for each source that is behind (\`rhen sources --problems\` lists them).` +
    (unchecked.length > 0
      ? ` ${unchecked.map((item) => item.name).join(", ")} ${unchecked.length === 1 ? "reports" : "report"} no coverage, so how far ${unchecked.length === 1 ? "it is" : "they are"} read is unknown: the collector must post a coverage row (docs/operations/posting-messages.md, section 5).`
      : "");
  const sentence =
    read.length > 0
      ? `This plan is built from messages read up to ${stamp(read[0]!.coveredTo!)} (${count}: ${behind.map((item) => item.name).join(", ")}). Anything newer is not in it. ${next}`
      : `This plan is built without knowing how far messages from ${behind.map((item) => item.name).join(", ")} are read (${count}): nothing has been reported as read. ${next}`;
  return { complete: false, behind, sentence, note };
}

/** One plain line per message source on collected against decided; empty when none has anything to report. */
export function processingLines(slice: DoctorSourcesSlice): string[] {
  return (slice.processing ?? []).flatMap((report) => processingLine(report) ?? []);
}

function silentDevices(
  slice: DoctorSourcesSlice
): Map<string, { device: DoctorDeviceInput; feeds: DoctorSourceInput[] }> {
  const byId = new Map(slice.sources.map((source) => [source.id, source]));
  const out = new Map<string, { device: DoctorDeviceInput; feeds: DoctorSourceInput[] }>();
  for (const device of slice.devices) {
    if (device.lastSeenAt === null) continue;
    const feeds = device.entries
      .map((id) => byId.get(id))
      .filter((source): source is DoctorSourceInput => source !== undefined && source.configured);
    if (feeds.length < DOCTOR_DEVICE_MIN_FEEDS) continue;
    if (feeds.every((feed) => feed.threshold !== null && isLate(feed))) out.set(device.id, { device, feeds });
  }
  return out;
}

export function sourceItems(
  slice: DoctorSourcesSlice,
  now: number
): { items: DoctorItem[]; counts: DoctorSourceCounts; devicePing: boolean } {
  const items: DoctorItem[] = [];
  const silent = silentDevices(slice);
  const inSilentDevice = new Set([...silent.values()].flatMap(({ feeds }) => feeds.map((feed) => feed.id)));

  for (const { device, feeds } of silent.values()) {
    const seen = ms(device.lastSeenAt)!;
    const widest = Math.max(...feeds.map((feed) => feed.threshold!.warnHours));
    const from = feeds.find((feed) => feed.id === device.lastSeenFrom);
    items.push({
      id: `device_silent:${device.id}`,
      check: "device_silent",
      tier: feeds.some((feed) => blockingLate(feed, now)) ? "blocking" : "degrading",
      area: "integrations",
      title: `The ${device.id} device has sent nothing for ${age(seen, now)}${from ? ` (last heard through ${from.name})` : ""}`,
      why: `All ${feeds.length} of its feeds (${feeds.map((feed) => feed.name).join(", ")}) are past their usual rhythm, the longest of which is ${widest} h, so the device itself has gone quiet rather than one feed. Whatever the plan learns from it is going stale, and the per-feed items are folded into this one.`,
      handles: [`device:${device.id}`],
      since: device.lastSeenAt!,
      fix: {
        who: "person",
        question: `Nothing has come from the ${device.id} device for ${age(seen, now)}. Is it switched off, out of range of the portal, or signed out? Ask the owner to wake it and make it send once. If it is on and still silent, run ${feeds
          .map((feed) => `\`rhen sources ${feed.id}\``)
          .join(
            ", "
          )} to see each feed's last error and the token it uses, and \`rhen agent-token list\` to check the tokens are live.`,
        cli: `rhen sources ${feeds[0]!.id}`
      }
    });
  }

  for (const source of slice.sources) {
    if (source.keepsSyncChecks) continue;

    const kinds = source.lateKinds ?? [];
    const late = pastThreshold(source);
    if ((late || kinds.length > 0) && !inSilentDevice.has(source.id)) {
      const last = ms(source.lastSuccessAt);
      const warn = source.threshold?.warnHours;
      const blocking = blockingLate(source, now);
      const coverage = source.coverage;
      const covered = coverage !== undefined && coverage.coveredTo !== null;
      const origin = source.threshold?.from ?? "default";
      const retired = late && covered && abandoned(source, now);
      const rule = `${limitRule(source) ?? `Its warning comes after ${warn} h${source.threshold?.errorHours != null ? ` and its error after ${source.threshold.errorHours} h` : ""} (${origin} threshold).`}${awaitingConfirmation(source, now) ? ` The usual rhythm changed (last gap ${formatSpan(source.threshold!.rhythmChanged!.lastGapHours * HOUR_MS)}), not blocking until confirmed.` : ""}${retired ? ` This source has probably been retired: it is more than ${RHYTHM_ABANDONED_FACTOR} x its stale limit behind, so it no longer blocks.` : ""}`;
      const title = late
        ? covered
          ? `${source.name} is read up to ${stamp(coverage.coveredTo!)}, ${age(last ?? now, now)} behind${rhythmClause(source.threshold)}`
          : `${source.name} last sent data ${last === undefined ? "a long while" : age(last, now)} ago, later than usual`
        : `${source.name} has stopped sending ${kinds.map((k) => k.kind).join(", ")} while the rest still arrives`;
      const alive = coverage?.heartbeat?.status === "ok";
      const live = (coverage?.scopes ?? []).filter((scope) => scope.retired !== true);
      const label = (scope: string | null) => (scope === null ? "(no scope)" : `"${scope}"`);
      let held = "";
      if (covered && live.length > 1) {
        const slow = [...live].sort((a, b) => a.coveredTo.localeCompare(b.coveredTo))[0]!;
        const fast = [...live].sort((a, b) => b.coveredTo.localeCompare(a.coveredTo))[0]!;
        held = ` Held back by the scope ${label(slow.scope)} (read up to ${stamp(slow.coveredTo)}); the newest scope is ${label(fast.scope)} (up to ${stamp(fast.coveredTo)}). If ${label(slow.scope)} was renamed or removed, it stops holding the source back 31 days after its last window; to clear it sooner, have the collector post a coverage window for that scope up to now.`;
      }
      items.push({
        id: `source_late:${source.id}`,
        check: "source_late",
        tier: blocking ? "blocking" : "degrading",
        area: "integrations",
        title,
        why: late
          ? covered
            ? `This source reports how far it has been read, and that is ${stamp(coverage.coveredTo!)}, so anything newer is not in the plan${alive ? `; the collector is alive (heartbeat ok at ${stamp(coverage.heartbeat!.at)}) but is not reading` : "; the collector has sent no healthy heartbeat since"}.${held} ${feedsPlan(source) ? (source.changesPlan === true ? "Messages from this source can change the plan, so it is being made without them." : "The planning engine reads this source, so the plan is being made from old data.") : "Nothing the plan depends on is blocked, but what this source gives you has stopped updating."} ${rule}`
            : `${feedsPlan(source) ? "The planning engine reads this source, so the plan is being made from old data." : "Nothing the plan depends on is blocked, but what this source gives you has stopped updating."} ${rule}`
          : `Each kind follows its own rhythm, learned from the last 30 days. ${kinds.map((k) => `${k.kind} has not arrived for ${age(ms(k.lastAt) ?? now, now)}, past its usual ${k.warnHours} h`).join("; ")}. One trigger or sender has probably stopped.`,
        handles: [`source:${source.id}`],
        ...(source.lastSuccessAt ? { since: source.lastSuccessAt } : {}),
        fix: {
          who: "person",
          question: retired
            ? `${source.name} has not been read since ${stamp(coverage.coveredTo!)} and is more than ${RHYTHM_ABANDONED_FACTOR} x its stale limit behind, so it has probably been retired. Run \`rhen sources ${source.id}\` to see each scope's covered-up-to time and the newest heartbeat. ${RETIRED_NEXT} Run \`rhen sources ${source.id}\` again to confirm.`
            : covered
              ? `${source.name} has not been read since ${stamp(coverage.coveredTo!)}. Run \`rhen sources ${source.id}\` to see each scope's covered-up-to time, the newest heartbeat and the threshold in use. Then ask the owner whether the collector that reads it is still running and signed in, and have them make it read once. Run \`rhen sources ${source.id}\` again: covered up to should now be minutes old, and \`rhen sources --problems\` should no longer list it.${source.activitySource !== undefined ? ` ${askOwnerExpectation(source.activitySource)}` : ""}`
              : `${source.name} has not sent on its usual rhythm. Run \`rhen sources ${source.id}\` to see its last error, the kinds that still arrive and the threshold in use. Then ask the owner whether the automation or device that sends it is still switched on, and have them make it send once. Run \`rhen sources ${source.id}\` again: its newest row should now be minutes old, and \`rhen sources --problems\` should no longer list it.`,
          cli: `rhen sources ${source.id}`
        }
      });
    }

    const heartbeat = source.coverage?.heartbeat;
    if (source.freshness === "failing" && source.coverage && !inSilentDevice.has(source.id)) {
      const coveredTo = source.coverage.coveredTo;
      const errorHours = source.threshold?.errorHours;
      const lastRead = ms(coveredTo);
      const past =
        errorHours != null &&
        (lastRead === undefined || now - lastRead > errorHours * HOUR_MS) &&
        statedThreshold(source);
      items.push({
        id: `source_late:${source.id}`,
        check: "source_late",
        tier: past && feedsPlan(source) ? "blocking" : "degrading",
        area: "integrations",
        title: `${source.name}'s collector reports an error${coveredTo ? `; read up to ${stamp(coveredTo)}` : ""}`,
        why: `The collector's newest heartbeat says it failed${heartbeat?.error ? `: ${heartbeat.error}` : ""} (text from the collector, untrusted). ${coveredTo ? `Nothing after ${stamp(coveredTo)} is in the plan.` : "Nothing from this source has been reported as read."}`,
        handles: [`source:${source.id}`],
        ...(coveredTo ? { since: coveredTo } : {}),
        fix: {
          who: "person",
          question: `Run \`rhen sources ${source.id}\` to see the error, each scope's covered-up-to time and the threshold in use. Then ask the owner to fix what the error says (usually the collector's sign-in or network) and make it read once. Run \`rhen sources ${source.id}\` again: the freshness should be fresh and the error gone.`,
          cli: `rhen sources ${source.id}`
        }
      });
    }

    if (source.freshness === "never" && (source.credentialPresent === true || source.coverage?.heartbeat)) {
      const aliveOnly = source.coverage?.heartbeat != null && source.coverage.coveredTo === null;
      items.push({
        id: `source_silent:${source.id}`,
        check: "source_silent",
        tier: "degrading",
        area: "integrations",
        title: aliveOnly
          ? `${source.name}'s collector is alive but has never reported reading anything`
          : `${source.name} has a token but has never sent anything`,
        why: aliveOnly
          ? "The collector sends heartbeats, so it is running, but it has not reported any window as read (a coverage row), so nothing from this source is known to be in the plan."
          : "A live token for this source exists, so it was set up on the server, yet nothing has ever arrived and the token has never been used. The sender is not configured, or it is posting somewhere else.",
        handles: [`source:${source.id}`],
        fix: {
          who: "person",
          question: aliveOnly
            ? `Ask the owner to make the collector for ${source.name} read once and post a coverage row (POST /api/activity-events with kind coverage; the exact fields are in docs/operations/posting-messages.md). Run \`rhen sources ${source.id}\` afterwards: it should show a covered-up-to time.`
            : `Check that the device or script for ${source.name} was given this token and the portal address, then ask the owner to run it once. If a different token name was used, correct tokenName for this entry in the extension's data-flow amend. Run \`rhen agent-token list\` to see which token names exist and when each was last used.`,
          cli: `rhen sources ${source.id}`
        }
      });
    }

    const importRun = source.latestImport;
    const runAt = ms(importRun?.at);
    if (
      importRun &&
      importRun.status === "needs_review" &&
      runAt !== undefined &&
      now - runAt <= DOCTOR_IMPORT_REVIEW_DAYS * DAY_MS
    ) {
      const skipped = importRun.skipped;
      items.push({
        id: `import_needs_review:${source.id}`,
        check: "import_needs_review",
        tier: "tidy",
        area: "integrations",
        title:
          skipped > 0
            ? `${source.name} import skipped ${number(skipped)} rows`
            : `${source.name} import finished with warnings`,
        why: "The file was read and most of it was kept, but some rows were refused, so part of that history is missing. Importing the same file again is safe: rows already held are recognised and not duplicated.",
        handles: [`source:${source.id}`],
        since: importRun.at,
        fix: {
          who: "person",
          question: `Look at the import's warnings, then decide whether the missing rows matter. If they do, make a fresh export and run \`rhen import ${source.activitySource ?? source.id} <path to the export file, zip or folder>\` again (rows already held are not duplicated); otherwise leave it. Run \`rhen sources ${source.id}\` to see this source's rows and last error.`,
          cli: `rhen sources ${source.id}`
        }
      });
    }
  }

  for (const issue of slice.issues) {
    items.push({
      id: `${issue.code}:${issue.entryId}`,
      check: issue.code,
      tier: issue.tier,
      area: "integrations",
      title: issue.title,
      why:
        issue.code === "probe_unresolved"
          ? "Doctor and the Data page cannot read this source's health, so it is shown as unresolved rather than as working. A source nobody can see into can stop without anyone noticing."
          : "Without a bound token the source is judged by its rows alone, so a device that has stopped calling can look healthy while old rows are still counted. Nothing is wrong with the data; the registry needs one fact.",
      handles: [`source:${issue.entryId}`],
      fix:
        issue.who === "person"
          ? { who: "person", question: issue.next, cli: `rhen sources ${issue.entryId}` }
          : { who: "agent", cli: `rhen sources ${issue.entryId}`, next: issue.next }
    });
  }

  const unusedRows = slice.sources.filter(
    (source) => !source.keepsSyncChecks && source.reachEmpty && (source.count7d ?? 0) > 0
  );
  if (unusedRows.length > 0) {
    const total = unusedRows.reduce((sum, source) => sum + (source.count7d ?? 0), 0);
    const names = unusedRows.sort((a, b) => (b.count7d ?? 0) - (a.count7d ?? 0)).map((source) => source.name);
    const shown = names.slice(0, 3).join(", ");
    items.push({
      id: "sources_collecting_unused",
      check: "sources_collecting_unused",
      tier: "tidy",
      area: "integrations",
      title: `${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ""} sent ${number(total)} rows this week that nothing uses`,
      why: "These sources are collecting data that reaches no page, no plan input and no agent tool, so it costs storage and gives nothing back. One-off archives that sit unused are not counted here.",
      handles: unusedRows.map((source) => `source:${source.id}`),
      fix: {
        who: "person",
        question: `Decide whether to keep collecting ${shown}${names.length > 3 ? " and the others" : ""}. To stop, switch off the sender on the device or script that posts it; to keep the data for later, leave it. Run \`rhen sources --unused\` to list every unused source and the kinds nothing reads.`,
        cli: "rhen sources --unused"
      }
    });
  }

  const counts = {
    // The count of the source_late items above, so the header never says more than the report lists.
    late: items.filter((item) => item.check === "source_late").length,
    deviceSilent: silent.size,
    collectedUnused: slice.unused,
    nothingSends: slice.nothingSends
  };
  const devicePing = [...silent.values()].some(({ feeds }) => feeds.some((feed) => feed.phonePing === true));
  return { items, counts: { ...counts, line: sourceCountsLine(counts) }, devicePing };
}
