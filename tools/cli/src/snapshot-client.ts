import { readFileSync } from "node:fs";
import { normaliseState, type PortalClient, type PortalState } from "./client.js";
import { CliError, EXIT } from "./errors.js";

export interface SnapshotClientOptions {
  /** Reads the snapshot file's raw text. Defaults to a real filesystem read; tests inject a stub. */
  readFile?: ((path: string) => string) | undefined;
}

/**
 * Parses a `rhen state --json` snapshot (with no `--key`, so it is the whole normalised
 * document, `planning` included) back into the same shape `PortalClient.getState()` returns. Running
 * it through `normaliseState` again is a no-op on a well-formed snapshot — the file already holds
 * contract-shaped data — but it keeps this path honest if the snapshot predates a contract change.
 */
export function loadSnapshot(path: string, options: SnapshotClientOptions = {}): PortalState {
  const readFile = options.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    throw new CliError(
      `Cannot read --state-file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.usage
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(
      `--state-file ${path} is not valid JSON. It should be the output of "rhen state --json" (no --key).`,
      EXIT.usage
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new CliError(
      `--state-file ${path} does not hold a state document. It should be the output of ` +
        `"rhen state --json" (no --key).`,
      EXIT.usage
    );
  const warnings: string[] = [];
  const state = normaliseState(raw as Record<string, unknown>, (message) => warnings.push(message));
  for (const warning of warnings) console.error(warning);
  return state;
}

/**
 * A `PortalClient` that never touches the network: `getState()` answers from a snapshot loaded once
 * at construction, and every other call is refused with a clear error, since a frozen snapshot has no
 * answer for it. Every read command the design names (list, show, state, status, schema, guide) reads
 * through `getState()`, so this one seam serves all of them; `changes` and `proposals`, and
 * `status`'s check-in lookup, call `get()` for endpoints a snapshot cannot answer — `status` already
 * treats that failure as "no check-in" rather than fatal, so it still works, just without a check-in.
 */
export function createSnapshotClient(path: string, options: SnapshotClientOptions = {}): PortalClient {
  const state = loadSnapshot(path, options);
  const refuse = (what: string) => (): never => {
    throw new CliError(
      `--state-file serves reads from a saved snapshot and never contacts the portal; ${what} has no snapshot answer.`,
      EXIT.unavailable
    );
  };
  return {
    baseUrl: `state-file:${path}`,
    getState: async () => state,
    get: async () => refuse("this request")(),
    post: async () => refuse("a write")(),
    put: async () => refuse("a write")(),
    del: async () => refuse("a write")(),
    getBinary: async () => refuse("a file download")()
  };
}
