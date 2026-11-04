import {
  ancestorClosedRefusal,
  childrenOpenRefusal,
  closeEntityCommandSchema,
  restoreCall,
  restoreStatus,
  type CloseEntityCommand,
  type CloseEntityResult,
  type CloseType
} from "@openrhen/contracts";
import { versionConflict } from "@/server/persistence/postgres/command-errors";

/**
 * Helpers for tests that stand in for `POST /api/commands/close`. A stand-in server that accepts any body proves
 * nothing, so `parseCloseBody` fails the test when a posted body does not parse with the route's own schema, and the
 * replies are built from the same helpers the real handler uses (`restoreCall`, `childrenOpenRefusal`,
 * `ancestorClosedRefusal`, `versionConflict`), never hand-typed.
 */

export function parseCloseBody(init: RequestInit | undefined): CloseEntityCommand {
  const parsed = closeEntityCommandSchema.safeParse(JSON.parse(String(init?.body ?? "null")));
  if (!parsed.success) throw new Error(`The posted body is not a close command: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as Response;

/** The closed status a verb writes: archive writes archived, cancel writes cancelled. */
const closedStatusOf = (command: CloseEntityCommand) => (command.verb === "archive" ? "archived" : "cancelled");

/** The result of a close or restore as the handler builds it, for a row at `version` before the call. */
export function resultFor(
  command: CloseEntityCommand,
  options: { version: number; cascaded?: CloseEntityResult["cascaded"]; skipped?: CloseEntityResult["skipped"]; closedFrom?: string }
): CloseEntityResult {
  const after = options.version + 1;
  if (command.do === "close") {
    const status = closedStatusOf(command);
    return {
      type: command.type,
      id: command.id,
      do: "close",
      verb: command.verb,
      status,
      version: after,
      batch: "11111111-1111-4111-8111-111111111111",
      restore: restoreCall(command.type, command.id, after, status),
      cascaded: options.cascaded ?? [],
      skipped: options.skipped ?? [],
      dependents: []
    };
  }
  const landing = restoreStatus(command.type, options.closedFrom ?? null);
  return {
    type: command.type,
    id: command.id,
    do: "restore",
    verb: command.verb,
    status: landing.status,
    version: after,
    batch: null,
    restoredTo: landing.status,
    assumed: landing.assumed,
    restore: null,
    cascaded: options.cascaded ?? [],
    skipped: options.skipped ?? [],
    dependents: []
  };
}

/** The 200 body of the close route: `{ state, closed }`. */
export const closeReply = (state: unknown, closed: CloseEntityResult): Response => jsonResponse({ state, closed });

/** The 400 the route answers when an area, outcome or project still has open children: the refusal's text and next call. */
export function childrenRefusalReply(command: CloseEntityCommand, count: number, deadlined: string[] = []): Response {
  const refusal = childrenOpenRefusal({
    type: command.type,
    id: command.id,
    verb: command.verb,
    version: command.expectedVersion ?? 1,
    count,
    deadlined
  });
  return jsonResponse({ error: refusal.message, nextCall: refusal.nextCall }, 400);
}

/** The 400 for a restore under a closed parent. */
export function ancestorRefusalReply(command: CloseEntityCommand, ancestor: { type: CloseType; id: string; status: string; version: number }): Response {
  const refusal = ancestorClosedRefusal({ type: command.type, id: command.id, ancestor });
  return jsonResponse({ error: refusal.message, nextCall: refusal.nextCall }, 400);
}

/** The 409 for a stale version, with the body `withRoute` builds from a `CommandConflictError`. */
export function conflictReply(command: CloseEntityCommand, current: number): Response {
  const error = versionConflict(command.type, command.id, command.expectedVersion, current);
  return jsonResponse(
    {
      error: error.message,
      ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
      ...(error.nextCall === undefined ? {} : { nextCall: error.nextCall })
    },
    409
  );
}
