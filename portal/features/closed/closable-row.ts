import type { CloseType } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";

/** The row a close or restore button acts on, read from portal state. */
export interface ClosableRow {
  type: CloseType;
  id: string;
  title: string;
  status: string;
  version: number | undefined;
}

type Named = { id: string; status: string; version?: number | undefined };

function pick(type: CloseType, items: readonly Named[], id: string, title: (item: never) => string): ClosableRow | null {
  const item = id === "" ? undefined : items.find((candidate) => candidate.id === id);
  return item ? { type, id, title: title(item as never), status: item.status, version: item.version } : null;
}

export function closableRowIn(state: PortalState, type: CloseType, id: string): ClosableRow | null {
  switch (type) {
    case "area":
      return pick(type, state.areas, id, (item: { name: string }) => item.name);
    case "outcome":
      return pick(type, state.outcomes, id, (item: { title: string }) => item.title);
    case "project":
      return pick(type, state.projects, id, (item: { title: string }) => item.title);
    case "action":
      return pick(type, state.actions, id, (item: { title: string }) => item.title);
    case "deliverable":
      return pick(type, state.deliverables, id, (item: { title: string }) => item.title);
    case "commitment":
      return pick(type, state.commitments, id, (item: { title: string }) => item.title);
    case "routine_preset":
      return pick(type, state.routinePresets, id, (item: { name: string }) => item.name);
    case "condition_definition":
      return pick(type, state.conditionDefinitions, id, (item: { name: string }) => item.name);
  }
}

const NOUNS: Record<CloseType, string> = {
  area: "area",
  outcome: "outcome",
  project: "project",
  action: "action",
  deliverable: "deliverable",
  commitment: "commitment",
  routine_preset: "routine",
  condition_definition: "context"
};

/** The word a person uses for a type: a routine preset is a routine, a condition definition a context. */
export const noun = (type: CloseType): string => NOUNS[type];
