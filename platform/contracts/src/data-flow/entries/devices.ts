import type { FlowEntry } from "../types.js";

/** Device feeds: a registered activity source that nothing posts yet is `noProducer`. Seed entries only. */
export const DEVICE_ENTRIES: readonly FlowEntry[] = [
  {
    id: "iphone-health",
    name: "Health summary",
    role: "source",
    category: "device",
    method: "push",
    trigger: { kind: "on-request", by: "device" },
    noProducer: true,
    activitySource: "iphone-health",
    device: "phone",
    code: {},
    from: [],
    to: [],
    via: ["activity-ingest"],
    health: { kind: "activity", source: "iphone-health" }
  }
];
