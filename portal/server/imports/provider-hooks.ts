// The registry the portal's shared server code reads providers through. A leaf module: it imports
// nothing, so the private seam (`@/server/private/providers`) can register into it whatever order the graph loads
// in. Shared code never names the roster provider or the calendar provider; OpenRhen registers them in the seam, and the OpenRhen export
// ships an empty seam, so there the registry stays empty and every hook is a no-op.

import type { CalendarSyncAdapter } from "./calendar-sync";
import type { sqlPool } from "@/server/persistence/postgres/sql-pool";

/** Asks for a publish sweep to whatever calendar sink is connected. Debounced and fire-and-forget. */
export type PublishRequester = () => void;

/** A sweep result as the routes report it: `failed` maps to a 502. */
export type ProviderRunResult = { status: string };

/**
 * The provider-specific work behind `/api/connections/[connectionId]/...`. A connection with no entry here
 * gets the generic behaviour (the calendar sync, the proxy proof) or a 404 for the ops only a provider has.
 */
export interface ProviderConnectionHandlers {
  /** A roster-profile connection's own sync body. Without it a roster profile is unsupported. */
  sync?(args: { trigger: "manual" | "scheduled" }): Promise<ProviderRunResult>;
  /** The connection's own credential proof, in place of the generic calendar-source proof. */
  proof?(): Promise<ProviderRunResult>;
  /** A calendar sink's publish sweep, its status, removal and write proof. */
  publish?: {
    run(args: { trigger: "manual" | "scheduled"; approveDeletes?: number }): Promise<ProviderRunResult>;
    status(sql: ReturnType<typeof sqlPool>, userId: string): Promise<unknown>;
    removeAll(): Promise<ProviderRunResult>;
    writeProof(): Promise<ProviderRunResult>;
  };
  /**
   * Previews a shared calendar's events as import candidates for the window, and says what to show when there
   * are none. Only a shared-calendar connection with a handler here has an import preview.
   */
  importPreview?(args: {
    mode: "new" | "updates";
    timezone: string;
    dateStart: string;
    dateEnd: string;
  }): Promise<{ batch: unknown; message?: string }>;
}

const requesters: PublishRequester[] = [];
const handlersById = new Map<string, ProviderConnectionHandlers>();

export function registerPublishRequester(requester: PublishRequester): void {
  if (!requesters.includes(requester)) requesters.push(requester);
}

/** Asks every registered sink to publish; a no-op where none is registered. */
export function requestCalendarPublish(): void {
  for (const requester of requesters) requester();
}

export function registerProviderConnectionHandlers(id: string, handlers: ProviderConnectionHandlers): void {
  handlersById.set(id, handlers);
}

export function providerConnectionHandlers(id: string): ProviderConnectionHandlers | undefined {
  return handlersById.get(id);
}

const adaptersByProfile = new Map<string, CalendarSyncAdapter>();

/** Registers the calendar-sync adapter for a diff profile whose provider is not built in. */
export function registerCalendarSyncAdapter(profile: string, adapter: CalendarSyncAdapter): void {
  adaptersByProfile.set(profile, adapter);
}

export function calendarSyncAdapterFor(profile: string): CalendarSyncAdapter | undefined {
  return adaptersByProfile.get(profile);
}
