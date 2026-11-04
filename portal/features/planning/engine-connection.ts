import type { PlanningRuntimeState } from "@openrhen/contracts";

export interface EngineConnectionView {
  label: string;
  tone: "connected" | "waiting" | "failed";
  summary: string;
}

export function engineConnectionView(planning: PlanningRuntimeState | undefined, ready = true): EngineConnectionView {
  if (!ready) return { label: "Checking", tone: "waiting", summary: "Loading the saved engine runtime state." };
  if (!planning)
    return {
      label: "Unavailable",
      tone: "waiting",
      summary: "No Plan and Forecast Engine runtime state is available."
    };
  if (planning.status === "current")
    return {
      label: "Connected",
      tone: "connected",
      summary: "The latest engine result is current and available to the portal."
    };
  if (planning.status === "pending")
    return {
      label: "Updating",
      tone: "waiting",
      summary: planning.result
        ? "A previous engine result is available while the next calculation is queued or running."
        : "The first engine calculation is queued or running."
    };
  if (planning.status === "stale")
    return {
      label: "Stale",
      tone: "waiting",
      summary: "The last engine result has passed its validity boundary and is awaiting refresh."
    };
  if (planning.status === "failed")
    return {
      label: "Failed",
      tone: "failed",
      summary: "The latest engine calculation failed. Existing planning data was not changed."
    };
  return {
    label: "Unavailable",
    tone: "waiting",
    summary: planning.message ?? "The engine has not produced a result yet."
  };
}
