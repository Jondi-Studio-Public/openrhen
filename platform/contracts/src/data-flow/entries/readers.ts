import { PLAN_INPUT_TABLES } from "../surfaces.js";
import type { DatasetRef, FlowEntry } from "../types.js";

/** Plan-input tables the engine reader is handed and does not consume, each with why (finding E-1). */
const NOT_READ = [
  {
    table: "daily_plan_desired_actions",
    reason: "saved and shown on Today, but no engine rule reads desired wins"
  },
  {
    table: "daily_plan_deferred_actions",
    reason: "saved and shown on Today, but no engine rule reads deferred items"
  }
] as const;

const notRead = new Set<string>(NOT_READ.map((item) => item.table));

/** Readers: what turns stored data into something used. Seed entries only. */
export const READER_ENTRIES: readonly FlowEntry[] = [
  {
    id: "engine-plan-input",
    name: "Planning engine input",
    role: "reader",
    category: "engine",
    method: "derived",
    trigger: { kind: "loop", loop: "plan-forecast-jobs" },
    gives: "the plan, leave-by times and travel tiers",
    code: {
      paths: ["portal/server/persistence/postgres/state-read.ts"],
      loops: ["plan-forecast-jobs"]
    },
    from: PLAN_INPUT_TABLES.filter((table) => !notRead.has(table)).map((table): DatasetRef => `pg:${table}`),
    notRead: NOT_READ,
    to: ["surface:engine"],
    health: { kind: "max", table: "planning_runs", column: "calculated_at" }
  },
  {
    id: "watch-history-panel",
    name: "Review watch history",
    role: "reader",
    category: "operations",
    method: "derived",
    trigger: { kind: "on-request", by: "owner" },
    gives: "watch time by day and hour",
    code: {
      paths: ["portal/features/review/components/watch-history-panel.tsx"],
      routes: ["GET /api/review/watch-history"]
    },
    from: ["pg:watch_events"],
    to: ["surface:page/review"],
    health: { kind: "none", reason: "a page read; the import has the health" }
  }
];
