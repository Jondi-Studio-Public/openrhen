import type { FlowEntry } from "../types.js";
import { flow } from "./define.js";

/**
 * The drift detector's own rows (source `drift`; docs/architecture/drift.md): the local model's work labels, and the
 * owner's one-tap answers. The flag writer joins them when it is built. Nothing reads these rows into the plan.
 */
export const DRIFT_ENTRIES: readonly FlowEntry[] = [
  flow({
    id: "work-label-inference",
    name: "Work label inference",
    role: "reader",
    category: "derived",
    method: "derived",
    trigger: { kind: "loop", loop: "work-label-tick" },
    activitySource: "drift",
    code: {
      paths: [
        "portal/server/drift/work-label-runner.ts",
        "portal/server/drift/work-label-prompt.ts",
        "portal/server/derived/call-policy.ts",
        "portal/server/persistence/postgres/work-label-store.ts"
      ],
      routes: ["POST /api/integrations/work-label/tick"],
      loops: ["work-label-tick"]
    },
    gives: "whether each area counts as work, read from its public text by the local model",
    from: ["pg:areas", "pg:outcomes", "pg:projects", "pg:actions"],
    via: ["activity-ingest"],
    to: ["pg:activity_events[source=drift,kind=work_label]"],
    value: { note: "feeds the work-item rule once the flag writer is built" },
    health: { kind: "none", reason: "runs only when an area is new or changed" }
  }),
  flow({
    id: "work-label-correction",
    name: "Work label correction",
    role: "source",
    category: "manual",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    activitySource: "drift",
    code: {
      paths: [
        "portal/server/drift/work-labels.ts",
        "portal/server/persistence/postgres/work-label-store.ts",
        "portal/features/plan/components/area-work-label.tsx"
      ],
      routes: ["PUT /api/work-labels/[areaId]"]
    },
    from: ["pg:areas"],
    via: ["activity-ingest"],
    to: ["pg:activity_events[source=drift,kind=work_label]"],
    value: { note: "the owner's answer wins over the model's label" },
    health: { kind: "none", reason: "written on a tap; nothing to be late" }
  }),
  flow({
    id: "drift-reason-capture",
    name: "What pulled you off",
    role: "source",
    category: "manual",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    activitySource: "drift-reason",
    code: {
      paths: [
        "portal/server/drift/drift-reasons.ts",
        "portal/server/persistence/postgres/drift-reason-store.ts",
        "portal/features/check-in/components/check-in-banner.tsx"
      ],
      routes: ["POST /api/drift-reasons", "DELETE /api/drift-reasons/[checkInId]"]
    },
    gives: "the owner's own words about why they left the plan, kept until they delete them",
    from: ["pg:check_in"],
    via: ["activity-ingest"],
    to: ["pg:activity_events[source=drift-reason,kind=reason]"],
    value: { note: "private words: owner-only, never logged, kept in database backups" },
    health: { kind: "none", reason: "written on a tap; nothing to be late" }
  }),
  flow({
    id: "reason-tag-inference",
    name: "Reason tag inference",
    role: "reader",
    category: "derived",
    method: "derived",
    trigger: { kind: "loop", loop: "reason-tag-tick" },
    activitySource: "drift-reason",
    code: {
      paths: [
        "portal/server/drift/reason-tag-runner.ts",
        "portal/server/drift/reason-tag-prompt.ts",
        "portal/server/derived/call-policy.ts",
        "portal/server/persistence/postgres/drift-reason-store.ts"
      ],
      routes: ["POST /api/integrations/reason-tag/tick"],
      loops: ["reason-tag-tick"]
    },
    gives: "short phrases naming what pulled you off, from your words",
    from: ["pg:activity_events[source=drift-reason,kind=reason]"],
    via: ["activity-ingest"],
    to: ["pg:activity_events[source=drift-reason,kind=reason_tag]"],
    value: { note: "shown on Review for correction; nothing plans, scores or predicts from tags" },
    health: { kind: "none", reason: "runs only when a reason has no tags yet" }
  }),
  flow({
    id: "reason-tag-correction",
    name: "Reason tag correction",
    role: "source",
    category: "manual",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    activitySource: "drift-reason",
    code: {
      paths: [
        "portal/server/drift/reason-tags.ts",
        "portal/server/persistence/postgres/drift-reason-store.ts",
        "portal/features/check-in/components/reason-tags-card.tsx"
      ],
      routes: ["GET /api/drift-reasons", "PUT /api/drift-reasons/[checkInId]/tags"]
    },
    from: ["pg:activity_events[source=drift-reason,kind=reason]"],
    via: ["activity-ingest"],
    to: ["pg:activity_events[source=drift-reason,kind=reason_tag]"],
    value: { note: "the owner's tags win over the model's; free text, no preset list" },
    health: { kind: "none", reason: "written on a tap; nothing to be late" }
  })
];
