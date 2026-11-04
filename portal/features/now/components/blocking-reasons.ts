import type { BlockingReason } from "@openrhen/contracts";

/** The one list of blocking reasons, offered identically at a checkpoint and on the recommendation. */
export const BLOCKING_REASONS: { value: BlockingReason; label: string }[] = [
  { value: "missing_information", label: "Missing information" },
  { value: "waiting_on_someone", label: "Waiting on someone" },
  { value: "dependency", label: "Something else has to happen first" },
  { value: "context_unavailable", label: "Tool or place not available" },
  { value: "energy_or_health", label: "Energy or health" },
  { value: "technical_problem", label: "Technical problem" },
  { value: "other", label: "Other" }
];
