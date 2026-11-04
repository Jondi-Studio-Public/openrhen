import type { PortalState } from "@/state/portal-state";

export interface RecurringWindowOption {
  id: string;
  label: string;
  minutes: number;
}

/**
 * A routine tile can stand in for one occurrence of a recurring action, so the picker lists every
 * recurrence window across every recurring action, named so the action it belongs to is obvious.
 */
export function recurringWindowOptions(actions: PortalState["actions"]): RecurringWindowOption[] {
  return actions
    .filter((item) => item.schedulingMode === "recurring")
    .flatMap(
      (item) =>
        item.recurrence?.windows.map((window) => ({
          id: window.id,
          label: `${item.title} · ${window.name}`,
          minutes: item.expectedMinutes
        })) ?? []
    );
}

export interface CadenceActionOption {
  id: string;
  label: string;
  minutes: number;
}

/**
 * A routine step can instead stand in for a cadence action (cadence, no windows) — one
 * option per action, unlike `recurringWindowOptions` above, since a cadence action has no "windows"
 * concept for a step to pick among.
 */
export function cadenceActionOptions(actions: PortalState["actions"]): CadenceActionOption[] {
  return actions
    .filter((item) => item.schedulingMode === "cadence")
    .map((item) => ({ id: item.id, label: item.title, minutes: item.expectedMinutes }));
}
