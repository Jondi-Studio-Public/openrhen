import { createClientId } from "@/shared/client-id";
import type { PortalState } from "@/state/portal-state";

/**
 * Saves when the person woke: the same `settings` write the sleep settings page sends for that field,
 * sent alone so no other setting is rewritten with it. The server refuses a wake in the future.
 */
export function wakeCommand(state: PortalState, lastWokeAt: string) {
  return {
    commandId: createClientId(),
    expectedVersion: state.settings.version ?? null,
    type: "save_entity" as const,
    entityType: "settings" as const,
    entity: { lastWokeAt }
  };
}
