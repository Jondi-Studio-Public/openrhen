import type { Sql } from "./sql-pool";

/**
 * Registry of the providers a feature the OpenRhen export leaves out reports to doctor from a status of its own
 * rather than from `integration_sync_runs` (the seam rule in the design notes): the
 * last success, the last error and the run of failures the provider keeps itself. `private/index.ts` registers each
 * on import; the export excludes that folder and ships an empty `private/index.ts`, so doctor reads only the runs
 * the core connections record.
 */
export interface ExtensionSyncStatus {
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
}

export interface SyncStatusExtension {
  /** The provider name doctor shows. */
  provider: string;
  /** Null when the provider has recorded nothing. */
  read(sql: Sql): Promise<ExtensionSyncStatus | null>;
}

const extensions: SyncStatusExtension[] = [];

export function registerSyncStatusExtension(extension: SyncStatusExtension): void {
  if (!extensions.some((existing) => existing.provider === extension.provider)) extensions.push(extension);
}

/** Every registered provider that has recorded a status. */
export async function readExtensionSyncStatuses(sql: Sql): Promise<Array<{ provider: string } & ExtensionSyncStatus>> {
  const read = await Promise.all(
    extensions.map(async (extension) => ({ provider: extension.provider, status: await extension.read(sql) }))
  );
  return read.flatMap(({ provider, status }) => (status ? [{ provider, ...status }] : []));
}

/** Whether a status reads as failing: failures in a row, or an error newer than the last success. */
export function isFailingSyncStatus(status: ExtensionSyncStatus): boolean {
  const lastError = status.lastErrorAt ? Date.parse(status.lastErrorAt) : null;
  const lastOk = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : null;
  return status.consecutiveFailures > 0 || (lastError !== null && (lastOk === null || lastError > lastOk));
}

/** The later of the last success and the last error, or null when neither is recorded. */
export function lastSyncRunAt(status: ExtensionSyncStatus): string | null {
  return (
    [status.lastSuccessAt, status.lastErrorAt]
      .filter((v): v is string => v !== null)
      .sort()
      .pop() ?? null
  );
}
