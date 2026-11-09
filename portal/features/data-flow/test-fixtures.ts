import type { NodeHealth, ViewEntry } from "@openrhen/contracts/data-flow";
import type { DataFlowResponse } from "@openrhen/contracts/data-flow";

/**
 * A small generic registry for the /data tests: two file imports through one pipe into the activity store, a calendar
 * pull, a phone, two readers (the engine and a page) and a backup sink. No real names.
 */

export const NOW = new Date("2026-11-09T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const code = { paths: ["x.ts"] };

function entry(partial: Partial<ViewEntry> & Pick<ViewEntry, "id" | "name" | "role">): ViewEntry {
  return {
    category: "files",
    method: "file-import",
    trigger: { kind: "manual-run", where: "cli" },
    code,
    from: [],
    to: [],
    health: { kind: "none", reason: "test" },
    owner: "core",
    reach: "collected, gives nothing yet",
    ...partial
  };
}

export const ENTRIES: ViewEntry[] = [
  entry({
    id: "ingest",
    name: "Activity ingest",
    role: "pipe",
    to: ["pg:activity_events", "pg:activity_imports"],
    reach: "collected, gives nothing yet"
  }),
  entry({
    id: "music-export",
    name: "Music export",
    role: "source",
    via: ["ingest"],
    activitySource: "physiology",
    from: ["local:music-file"],
    to: [],
    reach: "collected, gives nothing yet"
  }),
  entry({
    id: "watch-export",
    name: "Watch history",
    role: "source",
    from: ["local:watch-file"],
    to: ["pg:watch_events", "pg:watch_imports"],
    reach: "Review: watch time by day and hour"
  }),
  entry({
    id: "calendar-pull",
    name: "Calendar pull",
    role: "source",
    category: "calendar",
    method: "api-pull",
    trigger: { kind: "connection-schedule" },
    from: ["ext:calendar-account"],
    to: ["pg:commitments", "pg:calendar_event_links"],
    freshness: "from-connection",
    credentials: ["CALENDAR_TOKEN"],
    reach: "Engine: the plan; Today: plan and schedule"
  }),
  entry({
    id: "phone-ping",
    name: "Phone location",
    role: "source",
    category: "device",
    method: "push",
    device: "phone",
    from: ["ext:device/phone"],
    to: ["pg:user_preferences"],
    reach: "Engine: the plan"
  }),
  entry({
    id: "phone-shortcuts",
    name: "Phone shortcuts",
    role: "source",
    category: "device",
    method: "push",
    device: "phone",
    noProducer: true,
    reach: "accepted, nothing sends"
  }),
  entry({
    id: "engine-input",
    name: "Planning engine input",
    role: "reader",
    category: "engine",
    method: "derived",
    from: ["pg:commitments", "pg:calendar_event_links", "pg:user_preferences"],
    to: ["surface:engine"],
    gives: "the plan",
    trigger: { kind: "loop", loop: "plan-forecast-jobs" }
  }),
  entry({
    id: "today-view",
    name: "Today view",
    role: "reader",
    category: "operations",
    method: "derived",
    from: ["pg:commitments", "pg:calendar_event_links"],
    to: ["surface:page/today"],
    gives: "plan and schedule"
  }),
  entry({
    id: "watch-panel",
    name: "Watch panel",
    role: "reader",
    category: "operations",
    method: "derived",
    from: ["pg:watch_events", "pg:watch_imports"],
    to: ["surface:page/review"],
    gives: "watch time by day and hour"
  }),
  entry({
    id: "backup-run",
    name: "Backup",
    role: "sink",
    category: "operations",
    method: "derived",
    passThrough: true,
    from: ["pg:commitments"],
    to: ["surface:backup"]
  }),
  entry({
    id: "planned-holidays",
    name: "Public holidays",
    role: "source",
    category: "device",
    planned: { landsAs: { activitySource: "holidays" } }
  })
];

const health = (
  entryId: string,
  freshness: NodeHealth["freshness"],
  hours: number | null,
  extra: Partial<NodeHealth> = {}
): NodeHealth => ({
  entryId,
  probe: "test",
  configured: true,
  freshness,
  lastSuccessAt: hours === null ? null : hoursAgo(hours),
  lastAttemptAt: hours === null ? null : hoursAgo(hours),
  lastError: null,
  threshold: { warnHours: 24, errorHours: 72, from: "default" },
  ...extra
});

export function response(overrides: Partial<DataFlowResponse> = {}): DataFlowResponse {
  const nodes: Record<string, NodeHealth> = {
    ingest: health("ingest", "n/a", null, { threshold: null }),
    "music-export": health("music-export", "fresh", 3, { kindsSeen: ["steps"], count7d: 40 }),
    "watch-export": health("watch-export", "fresh", 5),
    "calendar-pull": health("calendar-pull", "fresh", 1, { count24h: 12 }),
    "phone-ping": health("phone-ping", "fresh", 2),
    "phone-shortcuts": health("phone-shortcuts", "never", null, { configured: false }),
    "engine-input": health("engine-input", "fresh", 0.2),
    "today-view": health("today-view", "n/a", null, { threshold: null }),
    "watch-panel": health("watch-panel", "n/a", null, { threshold: null }),
    "backup-run": health("backup-run", "n/a", null, { threshold: null })
  };
  const entries = ENTRIES;
  return {
    generatedAt: NOW.toISOString(),
    build: "merged",
    entries,
    datasets: [],
    edges: [
      { from: "local:music-file", to: "music-export", kind: "reads" },
      { from: "music-export", to: "pg:activity_events[source=physiology]", kind: "writes" },
      { from: "ingest", to: "pg:activity_events", kind: "writes" },
      { from: "ingest", to: "pg:activity_imports", kind: "writes" },
      { from: "local:watch-file", to: "watch-export", kind: "reads" },
      { from: "watch-export", to: "pg:watch_events", kind: "writes" },
      { from: "watch-export", to: "pg:watch_imports", kind: "writes" },
      { from: "ext:calendar-account", to: "calendar-pull", kind: "reads" },
      { from: "calendar-pull", to: "pg:commitments", kind: "writes" },
      { from: "calendar-pull", to: "pg:calendar_event_links", kind: "writes" },
      { from: "ext:device/phone", to: "phone-ping", kind: "reads" },
      { from: "phone-ping", to: "pg:user_preferences", kind: "writes" },
      { from: "pg:commitments", to: "engine-input", kind: "reads" },
      { from: "pg:calendar_event_links", to: "engine-input", kind: "reads" },
      { from: "pg:user_preferences", to: "engine-input", kind: "reads" },
      { from: "engine-input", to: "surface:engine", kind: "writes" },
      { from: "pg:commitments", to: "today-view", kind: "reads" },
      { from: "pg:calendar_event_links", to: "today-view", kind: "reads" },
      { from: "today-view", to: "surface:page/today", kind: "writes" },
      { from: "pg:watch_events", to: "watch-panel", kind: "reads" },
      { from: "pg:watch_imports", to: "watch-panel", kind: "reads" },
      { from: "watch-panel", to: "surface:page/review", kind: "writes" },
      { from: "pg:commitments", to: "backup-run", kind: "reads" },
      { from: "backup-run", to: "surface:backup", kind: "writes" }
    ],
    devices: [{ id: "phone", ref: "ext:device/phone", entries: ["phone-ping", "phone-shortcuts"] }],
    unused: {
      entries: [
        { id: "music-export", bucket: "unused" },
        { id: "phone-shortcuts", bucket: "nothing-sends" }
      ],
      kinds: [],
      datasets: [],
      dead: []
    },
    health: {
      nodes,
      issues: [],
      devices: [
        {
          id: "phone",
          ref: "ext:device/phone",
          entries: ["phone-ping"],
          lastSeenAt: hoursAgo(2),
          lastSeenFrom: "phone-ping"
        }
      ],
      counts: { late: 0, stale: 0, failing: 0, never: 1, probe_unresolved: 0 }
    },
    ...overrides
  };
}

/** The fixture with one source made stale: the calendar pull last succeeded 100 hours ago. */
export function withStaleCalendar(): DataFlowResponse {
  const base = response();
  if (base.health.unavailable) throw new Error("fixture health is available");
  return {
    ...base,
    health: {
      ...base.health,
      nodes: { ...base.health.nodes, "calendar-pull": health("calendar-pull", "stale", 100) }
    }
  };
}
