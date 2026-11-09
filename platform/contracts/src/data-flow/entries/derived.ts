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
        "portal/server/derived/fact-ics.ts",
        "portal/server/persistence/postgres/derived-scan-store.ts",
        "portal/server/persistence/postgres/derived-write-store.ts",
        "portal/server/persistence/postgres/derived-lineage-store.ts",
        "portal/server/persistence/postgres/extractor-state-store.ts"
      ],
      routes: ["POST /api/integrations/derived/tick"],
      loops: ["derived-tick"]
    },
    gives: "message classes, and the events in calendar invites",
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
  }),
  flow({
    id: "derived-model-tick",
    name: "Model extractor tick",
    role: "reader",
    category: "derived",
    method: "derived",
    trigger: { kind: "loop", loop: "derived-model-tick" },
    activitySource: "derived",
    code: {
      paths: [
        "portal/server/derived/model-runner.ts",
        "portal/server/derived/model-extractor.ts",
        "portal/server/derived/model-extractor-registry.ts",
        "portal/server/persistence/postgres/derived-model-scan-store.ts"
      ],
      routes: ["POST /api/integrations/derived/model-tick"],
      loops: ["derived-model-tick"]
    },
    gives: "facts read from message text by the configured model",
    from: ["pg:activity_events[source=*]"],
    to: [
      "pg:activity_events[source=derived]",
      "pg:activity_events[source=derived-shadow]",
      "pg:derived_lineage",
      "pg:extractor_state"
    ],
    value: { note: "reads the text of every source with the configured model" },
    health: { kind: "none", reason: "no extractor is registered yet; the extractor that lands brings its own probe" }
  })
];
