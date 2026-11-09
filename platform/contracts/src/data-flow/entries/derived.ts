import type { FlowEntry } from "../types.js";
import { flow } from "./define.js";

/** The derived-rows runner and the shadow classifier: readers of the activity store that write rows back into it. */
export const DERIVED_ENTRIES: readonly FlowEntry[] = [
  flow({
    id: "derived-runner",
    name: "Derived rows runner",
    role: "reader",
    category: "derived",
    method: "derived",
    trigger: { kind: "loop", loop: "derived-tick" },
    activitySource: "derived",
    code: {
      paths: [
        "portal/server/derived/derived-runner.ts",
        "portal/server/derived/extractor-registry.ts",
        "portal/server/derived/extractor.ts",
        "portal/server/persistence/postgres/derived-write-store.ts",
        "portal/server/persistence/postgres/derived-lineage-store.ts",
        "portal/server/persistence/postgres/extractor-state-store.ts"
      ],
      routes: ["POST /api/integrations/derived/tick"],
      loops: ["derived-tick"]
    },
    gives: "message classes and facts for the evaluation report",
    from: ["pg:activity_events[source=*]"],
    to: ["pg:activity_events[source=derived]", "pg:derived_lineage", "pg:extractor_state"],
    value: { note: "classifies the text of every source" },
    health: { kind: "extractor", name: "msg-class" }
  }),
  flow({
    id: "derived-shadow-classifier",
    name: "Shadow classifier",
    role: "reader",
    category: "derived",
    method: "derived",
    trigger: { kind: "loop", loop: "derived-tick" },
    activitySource: "derived-shadow",
    code: {
      paths: ["portal/server/derived/msg-class-t0.ts", "portal/server/persistence/postgres/derived-write-store.ts"]
    },
    from: ["pg:activity_events[source=*]"],
    to: ["pg:activity_events[source=derived-shadow]"],
    value: { note: "classifies the text of every source" },
    health: { kind: "none", reason: "runs inside the derived tick; its runner has the probe" }
  })
];
