import { randomUUID } from "node:crypto";

type Fields = Record<string, unknown>;

/** A fresh id in the same shape the portal's own `createClientId()` gives a human editing a rule in the UI. */
export function newEntityId(): string {
  return randomUUID();
}

function hasId(value: unknown): value is Fields & { id: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const id = (value as Fields).id;
  return typeof id === "string" && id.trim().length > 0;
}

/**
 * Fills in a missing `recurrence.id` and any missing `recurrence.windows[].id` on a `save action`
 * payload, so an AI tool does not have to invent ids by hand the way the portal UI never does either
 * (`portal/features/plan/plan-commands.ts` calls `createClientId()` for both). Leaves any id already
 * present untouched — this only fills gaps, never overwrites an id meant to update an existing rule.
 */
export function withRecurrenceIds(entity: Fields): Fields {
  const recurrenceValue = entity.recurrence;
  if (!recurrenceValue || typeof recurrenceValue !== "object" || Array.isArray(recurrenceValue)) return entity;
  const recurrence = recurrenceValue as Fields;
  const windows = Array.isArray(recurrence.windows) ? recurrence.windows : undefined;
  return {
    ...entity,
    recurrence: {
      ...recurrence,
      id: hasId(recurrence) ? recurrence.id : newEntityId(),
      ...(windows
        ? {
            windows: windows.map((window) =>
              window && typeof window === "object" && !Array.isArray(window)
                ? { ...window, id: hasId(window) ? window.id : newEntityId() }
                : window
            )
          }
        : {})
    }
  };
}

/** True when a payload touches the recurring/cadence machinery, so a validation failure can point at the guide. */
export function mentionsRecurrence(entity: Fields): boolean {
  const mode = entity.schedulingMode;
  return (typeof mode === "string" && mode !== "one_off") || "recurrence" in entity;
}
