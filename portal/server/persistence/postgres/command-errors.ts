/**
 * The refusals every command handler raises, kept in their own module so a handler can throw
 * one without importing the whole store. Route handlers map them to 409, 400, 403 and 404 respectively.
 */

import {
  badValueRefusal,
  SHOW_ENTITIES,
  invalidChoiceRefusal,
  outOfRangeRefusal,
  requiredRefusal,
  notFoundRefusal,
  wrongStateRefusal,
  type AgentCall,
  type Refusal,
  type RefusalKind
} from "@openrhen/contracts";

/** What a refusal adds for an agent beyond its text: the exact next call and the accepted values. Both ride in the error body. */
export interface RefusalDetails {
  nextCall?: AgentCall;
  validValues?: Record<string, string[]>;
}

/**
 * The record changed since the caller read it, so the expected version no longer matches. Where the
 * stored version is at hand it rides along as `currentVersion`, and the 409 body carries it so an
 * agent can retry without re-reading the record first.
 */
export class CommandConflictError extends Error {
  readonly currentVersion?: number;

  readonly nextCall?: AgentCall;
  readonly validValues?: Record<string, string[]>;

  constructor(message: string, options: { currentVersion?: number } & RefusalDetails = {}) {
    super(message);
    if (typeof options.currentVersion === "number") this.currentVersion = options.currentVersion;
    if (options.nextCall !== undefined) this.nextCall = options.nextCall;
    if (options.validValues !== undefined) this.validValues = options.validValues;
  }
}

/** The command cannot be carried out in the current state; repeating it unchanged will not help. */
export class InvalidCommandError extends Error {
  readonly nextCall?: AgentCall;
  readonly validValues?: Record<string, string[]>;

  constructor(message: string, details: RefusalDetails = {}) {
    super(message);
    if (details.nextCall !== undefined) this.nextCall = details.nextCall;
    if (details.validValues !== undefined) this.validValues = details.validValues;
  }
}

/** Throws-ready errors built from the shared refusal texts (`notFoundRefusal` and friends in the contracts). */
export const refused = (refusal: Refusal): InvalidCommandError =>
  new InvalidCommandError(refusal.message, {
    ...(refusal.nextCall === undefined ? {} : { nextCall: refusal.nextCall }),
    ...(refusal.validValues === undefined ? {} : { validValues: refusal.validValues })
  });

/** "Project "p1" no longer exists": names the id the caller sent and the call that lists the real ones. */
export const notFound = (kind: RefusalKind | (string & {}), id: unknown, what?: string): InvalidCommandError =>
  refused(notFoundRefusal(kind, id, what));

/** The same, for a save that expected a version of a record that has since gone (a 409, as before). */
export const notFoundConflict = (
  kind: RefusalKind | (string & {}),
  id: unknown,
  what?: string
): CommandConflictError => {
  const refusal = notFoundRefusal(kind, id, what);
  return new CommandConflictError(
    refusal.message,
    refusal.nextCall === undefined ? {} : { nextCall: refusal.nextCall }
  );
};

/** A record in a state the command cannot act on: names the record, its state now, the states accepted, and the way on. */
export const wrongState = (input: Parameters<typeof wrongStateRefusal>[0]): InvalidCommandError =>
  refused(wrongStateRefusal(input));

/** A value outside its allowed set: names the field, what was sent and every accepted value. */
export const invalidChoice = (
  field: string,
  got: unknown,
  valid: readonly string[],
  options?: Parameters<typeof invalidChoiceRefusal>[3]
): InvalidCommandError => refused(invalidChoiceRefusal(field, got, valid, options));

/** The caller is an agent and the write is the owner's alone (data-flow settings, switches); repeating it will not help. */
export class ForbiddenCommandError extends Error {
  readonly nextCall?: AgentCall;
  readonly validValues?: Record<string, string[]>;

  constructor(message: string, details: RefusalDetails = {}) {
    super(message);
    if (details.nextCall !== undefined) this.nextCall = details.nextCall;
    if (details.validValues !== undefined) this.validValues = details.validValues;
  }
}

/** The record the command names does not exist (or is no longer kept), so there is nothing to act on; a route answers 404. */
export class NotFoundCommandError extends Error {
  readonly nextCall?: AgentCall;
  readonly validValues?: Record<string, string[]>;

  constructor(message: string, details: RefusalDetails = {}) {
    super(message);
    if (details.nextCall !== undefined) this.nextCall = details.nextCall;
    if (details.validValues !== undefined) this.validValues = details.validValues;
  }
}

/** The command id already belongs to a different write (another payload or command type); a route answers 409, and only a new command id will do. */
export class CommandIdReusedError extends Error {}

/** A write committed but the state it answers with could not be read back; a route answers 503 with `committed: true`, and repeating the command with the same id replays it. */
export class CommittedReadFailedError extends Error {
  constructor(cause?: unknown) {
    super("Saved, but the plan could not be read back. Repeat with the same command id to read it.", { cause });
  }
}

/**
 * The record changed after the caller read it. Names the record and both versions; when the stored version is known it
 * rides along as `currentVersion` (the MCP surface then adds the re-read and repeat steps), otherwise the exact read
 * call travels as `nextCall`.
 */
export const versionConflict = (
  kind: string,
  id: unknown,
  expected: number | null | undefined,
  actual?: number
): CommandConflictError => {
  const label = `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}`;
  const named =
    typeof id === "string" && id !== ""
      ? `${label} "${id.length > 80 ? `${id.slice(0, 80)}...` : id}"`
      : `This ${kind}`;
  const sent = expected === null || expected === undefined ? "" : `, not the ${expected} you sent`;
  const message =
    actual === undefined
      ? `${named} changed after you read it${expected === null || expected === undefined ? "" : ` (you sent version ${expected})`}.`
      : `${named} is at version ${actual} now${sent}: it changed after you read it.`;
  const entity = SHOW_ENTITIES[kind];
  return new CommandConflictError(message, {
    ...(actual === undefined ? {} : { currentVersion: actual }),
    ...(actual !== undefined || entity === undefined || typeof id !== "string" || id === ""
      ? {}
      : {
          nextCall: {
            tool: "rhen_show",
            arguments: { entity, id },
            note: "read it, then repeat with its version"
          }
        })
  });
};

/**
 * An undo or redo that cannot go ahead because of how things stand now. The write log is the one place an agent can
 * see which writes exist and their state, so the call that follows is always its listing; `note` says what to look for.
 */
export const revertConflict = (message: string, note: string): CommandConflictError =>
  new CommandConflictError(message, { nextCall: { tool: "rhen_undo", arguments: { list: true }, note } });

/**
 * Another session is already open, so a new one cannot start. Names the open one (id, status, what it is on) and the
 * call that ends it: an action session is finished with `rhen_session`, any other with `rhen_activity`.
 */
export const openSessionConflict = (open: {
  id: string;
  status?: string;
  target_type?: string | null;
}): CommandConflictError => {
  const onAction = open.target_type === undefined || open.target_type === null || open.target_type === "action";
  return new CommandConflictError(
    `Another session is already open (id ${open.id}${open.status ? `, ${open.status}` : ""}${
      open.target_type && !onAction ? `, on a ${open.target_type.replace(/_/g, " ")}` : ""
    }), and only one can be open at a time. End it first, then start the new one.`,
    {
      nextCall: onAction
        ? {
            tool: "rhen_session",
            arguments: { subcommand: "finish", outcome: "unsure" },
            note: "or pause, or block it; use outcome completed or progress if that is what happened"
          }
        : {
            tool: "rhen_activity",
            arguments: { subcommand: "finish", outcome: "stopped" },
            note: "or pause it; use outcome completed if the work is done"
          }
    }
  );
};

/**
 * A session command that needs the session in another state. `tool` is the one that drives it (`rhen_session` for an
 * action, `rhen_activity` for anything else); `fix` is the subcommand that moves it on from where it is, if there is one.
 */
export const wrongSessionState = (
  tool: "rhen_session" | "rhen_activity",
  id: string,
  state: string,
  allowed: readonly string[],
  fix?: string
): InvalidCommandError =>
  wrongState({
    kind: "session",
    id,
    state,
    allowed,
    nextCall:
      fix === undefined
        ? { tool: "rhen_status", arguments: {}, note: "shows the open session and what it can do now" }
        : { tool, arguments: { subcommand: fix }, note: `moves session ${id} on` }
  });

/** The record exists but is already closed (done, cancelled, skipped, answered): says its state, and the call that reads or reopens it. */
export const alreadyClosed = (kind: string, id: unknown, state: string, nextCall?: AgentCall): InvalidCommandError =>
  wrongState({
    kind,
    id,
    state,
    needs: `a ${kind} that is still open`,
    ...(nextCall === undefined ? {} : { nextCall })
  });

/** A number outside its range: the field, the value sent and the accepted range. */
export const outOfRange = (label: string, got: unknown, min: number, max: number, unit?: string): InvalidCommandError =>
  refused(outOfRangeRefusal(label, got, min, max, unit));

/** A value of the wrong shape: the field, the value sent, what is expected and an example. */
export const badValue = (label: string, got: unknown, expected: string, example?: string): InvalidCommandError =>
  refused(badValueRefusal(label, got, expected, example));

/** A required value that was not sent. */
export const requiredValue = (label: string, example?: string): InvalidCommandError =>
  refused(requiredRefusal(label, example));
