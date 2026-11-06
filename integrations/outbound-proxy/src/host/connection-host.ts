import { CONNECTION_MANIFEST_VERSION, type ConnectionManifest, type ConnectionStatus } from "@openrhen/contracts";
import { bundledConnections } from "./bundled-connections.js";
import { PLACEHOLDER_CREDENTIAL } from "./http.js";
import type { BoundConnection, ConnectionImpl } from "./connection-api.js";

export interface LoadedConnection {
  bound: BoundConnection;
  /** Absent when `create` threw. */
  impl?: ConnectionImpl;
  /** Every secret in one group is set. Reported only; it never blocks dispatch. */
  ready: boolean;
  missing: string[];
  failed: boolean;
}

/** Throws when the manifest's `version` is newer than this host supports. */
export function assertSupportedManifestVersion(manifest: Pick<ConnectionManifest, "id" | "version">): void {
  const version = manifest.version ?? 1;
  if (version > CONNECTION_MANIFEST_VERSION) {
    throw new Error(
      `Connection ${manifest.id} declares manifest version ${version}, but this host supports up to version ${CONNECTION_MANIFEST_VERSION}`
    );
  }
}

function isSet(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed) && trimmed !== PLACEHOLDER_CREDENTIAL;
}

/** Ready when one secret group is fully set; otherwise `missing` names the closest group's gaps. */
export function secretReadiness(
  anyOf: readonly (readonly string[])[],
  env: Record<string, string | undefined>
): { ready: boolean; missing: string[] } {
  let closest: string[] | undefined;
  for (const group of anyOf) {
    const missing = group.filter((name) => !isSet(env[name]));
    if (missing.length === 0) return { ready: true, missing: [] };
    if (!closest || missing.length < closest.length) closest = missing;
  }
  return { ready: false, missing: closest ?? [] };
}

/**
 * A manifest's readiness. A connection whose `credentialSource` is `request` holds no credential here (each call
 * carries its own), so it is always ready; any other follows its secret groups in `env`.
 */
export function manifestReadiness(
  manifest: Pick<ConnectionManifest, "secrets" | "credentialSource">,
  env: Record<string, string | undefined>
): { ready: boolean; missing: string[] } {
  return manifest.credentialSource === "request"
    ? { ready: true, missing: [] }
    : secretReadiness(manifest.secrets.anyOf, env);
}

/** Binds each connection to `env`. A `create` that throws is logged and marked failed until the process restarts; it never stops the host. */
export function loadConnections(
  bound: readonly BoundConnection[],
  env: Record<string, string | undefined>
): LoadedConnection[] {
  return bound.map((connection) => {
    const readiness = manifestReadiness(connection.manifest, env);
    try {
      assertSupportedManifestVersion(connection.manifest);
      return { bound: connection, impl: connection.create(env), ...readiness, failed: false };
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          message: "Outbound integrations proxy connection failed to load",
          connection: connection.manifest.id,
          detail: error instanceof Error ? error.message : String(error)
        })}\n`
      );
      return { bound: connection, ...readiness, ready: false, failed: true };
    }
  });
}

let hostConnections: LoadedConnection[] | undefined;

/** The bundled connections, loaded on first use. */
export function connectionHost(): LoadedConnection[] {
  hostConnections ??= loadConnections(bundledConnections(), process.env);
  return hostConnections;
}

/** Replaces the loaded set; `undefined` reloads the bundled one on next use. */
export function setConnectionHostForTests(loaded: LoadedConnection[] | undefined) {
  hostConnections = loaded;
}

export function connectionStatuses(): ConnectionStatus[] {
  // Readiness is re-read from the environment on each call, like every other env-backed value here.
  return connectionHost().map(({ bound, failed }) => {
    const readiness = manifestReadiness(bound.manifest, process.env);
    return {
      id: bound.manifest.id,
      label: bound.manifest.label,
      capabilities: bound.manifest.capabilities,
      ready: readiness.ready && !failed,
      missing: readiness.missing
    };
  });
}
