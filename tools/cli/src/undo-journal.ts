import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PortalState } from "./client.js";
import { getPath } from "./output.js";

/** One portal write the journal can send again: a route and the command body to post. */
export interface ReverseRequest {
  path: string;
  payload: Record<string, unknown>;
}

/** Where the record a write touched lives in portal state, so undo can read its current version. */
export interface JournalTarget {
  /**
   * A state path: an array key (`routineSteps`) with `id`, or a single record (`settings`). A single record
   * that can be a different row from one day or session to the next (`dailyPlan` is the latest day's plan,
   * `activeSession` whichever session is open) also carries the row's `id`, so another row is not mistaken for
   * it. Entries written before that have none and match whichever row is there.
   */
  stateKey: string;
  id?: string;
}

/** `superseded`: no longer reachable by `undo`/`redo` (its owner's history moved on, or its record is gone for good). */
export type JournalStatus = "applied" | "undone" | "superseded";

export interface JournalEntry {
  id: string;
  at: string;
  label: string;
  /** Sent by `undo`: puts the record back as it was before the write. */
  undo: ReverseRequest;
  /** Sent by `redo`: the original write again. */
  redo: ReverseRequest;
  target: JournalTarget;
  status: JournalStatus;
  /**
   * The target's version as the last journaled write left it: what `undo`/`redo` send as `expectedVersion`,
   * so a later edit makes the reversal conflict instead of overwriting it. A number is that version; `null`
   * means the record was absent after the write (an undone add). Missing on entries written before this
   * field existed, or when the write's answer did not show the record: `undo` then refuses without `--force`.
   */
  version?: number | null;
  /** Who made the write (`agent:<name>`, `token:<fingerprint>` or `unlabeled`); missing on older entries. `undo` only reverses its own. */
  owner?: string;
  /**
   * Set while the entry is undone: which undo this was, counting up across the journal, so `redo` takes the
   * entry undone last (undo order is the reverse of write order, and so is redo's). Missing on entries undone
   * before this field existed, which `redo` orders by their place in the journal as it always did.
   */
  undoSeq?: number;
  /**
   * Set while the entry is undone by a checked undo: the version that undo read and sent as `expectedVersion`.
   * `redo` uses it to prove the entry undone before this one left the record exactly as this undo found it,
   * which a version count cannot show when this undo deleted the record. Missing after a forced undo or on
   * entries undone before this field existed.
   */
  undoReadVersion?: number;
  /**
   * Set while the entry is undone by the owner (the portal's "Agent changes" list, which runs `undo` as the owner):
   * the agent that made the write can then neither redo it nor have a later write of its own supersede it, so
   * the owner's reversal stays theirs to put back. Only the portal sets it (never an argument), and `--any-owner`
   * is how a redo reaches it.
   */
  undoneBy?: "owner";
  /**
   * Set on a write the portal reverts from rows it saved itself (a session, a check-in, a catch-up settle or an
   * Inbox confirm made by an agent): `undo`/`redo` post the entry's `/api/commands/revert` request and let the portal decide, since
   * it refuses unless nothing the write touched changed since. No record version is kept or sent, so the
   * client-side version checks (`version`, `undoReadVersion`, the sibling refresh) do not apply; the entry's
   * target is the write's command id under the pseudo state key `revert`, which no state record matches.
   */
  serverChecked?: true;
}

export interface Journal {
  read(): JournalEntry[];
  write(entries: JournalEntry[]): void;
  /** Most entries this journal keeps; `JOURNAL_LIMIT` when unset. The portal keeps more per agent than a local file does. */
  limit?: number;
  /**
   * The portal rebuilds this journal from its write ledger on every call (an agent on `/mcp`), so only a write the
   * portal reverts itself (server-checked) can be undone later: an entry the CLI restates is not recorded.
   */
  serverCheckedOnly?: true;
}

/** The most writes a journal keeps by default; older ones fall off, so undo reaches back a bounded way. */
export const JOURNAL_LIMIT = 50;

export function fileJournal(path = join(homedir(), ".openrhen", "undo-log.json"), limit?: number): Journal {
  return {
    ...(limit === undefined ? {} : { limit }),
    read() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed) ? (parsed as JournalEntry[]) : [];
      } catch {
        return [];
      }
    },
    write(entries) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(entries), "utf8");
      } catch {
        /* the write already landed; losing its undo record must not fail the command */
      }
    }
  };
}

export function memoryJournal(initial: JournalEntry[] = [], limit?: number): Journal {
  let entries = initial;
  return {
    ...(limit === undefined ? {} : { limit }),
    read: () => entries,
    write: (next) => {
      entries = next;
    }
  };
}

/** The state key of a server-checked entry's target: not a real state path, so no record's version is ever read for it. */
export const REVERT_STATE_KEY = "revert";

/** The portal route that puts a snapshotted write back (or forward again). */
export const REVERT_PATH = "/api/commands/revert";

/**
 * The requests and target for a write the portal snapshotted: undo and redo both post the write's command id
 * (`revertible` in the portal's answer) to the revert route, which does its own check against what changed since.
 */
export function serverCheckedReverse(revertible: string): {
  undo: ReverseRequest;
  redo: ReverseRequest;
  target: JournalTarget;
} {
  return {
    undo: { path: REVERT_PATH, payload: { target: revertible, direction: "undo" } },
    redo: { path: REVERT_PATH, payload: { target: revertible, direction: "redo" } },
    target: { stateKey: REVERT_STATE_KEY, id: revertible }
  };
}

/** The write kinds whose server handler inserts the row when it is missing and the request says `expectedVersion: null`. */
const RECREATING_ENTITY_TYPES = new Set([
  "area",
  "outcome",
  "commitment",
  "deliverable",
  "routine_step",
  "routine_preset",
  "planning_focus",
  "span",
  "condition_definition",
  "daily_plan"
]);
const RECREATING_PATHS = new Set(["/api/commands/project", "/api/commands/action"]);

/**
 * Whether sending `request` with `expectedVersion: null` puts its record back when that record has since been
 * deleted, which is what `--force` relies on for a vanished target. True for a save that restates the whole
 * record (the entity handlers in `portal/server/persistence/postgres/entity-commands.ts` and the project and
 * action routes insert a missing row, as `span set`'s before-image does). False for everything else: a removal,
 * a step skip or reopen, a pause or resume (the handlers act on an existing row and refuse a missing one), and
 * kinds that refuse to create from a restated record (a sleep plan, a capture).
 */
export function canRecreate(request: ReverseRequest): boolean {
  if (RECREATING_PATHS.has(request.path)) return true;
  if (request.path !== "/api/commands/entity") return false;
  const { entityType, entity } = request.payload;
  if (typeof entityType !== "string" || !RECREATING_ENTITY_TYPES.has(entityType)) return false;
  return (entity as { remove?: unknown } | undefined)?.remove !== true;
}

/** The stored version of the record a journal target names: undefined when the record no longer exists, null when it has none. */
export function currentVersion(state: PortalState, target: JournalTarget): number | null | undefined {
  const found = getPath(state, target.stateKey);
  const single = found !== null && typeof found === "object" && !Array.isArray(found);
  const record =
    target.id === undefined
      ? found
      : Array.isArray(found)
        ? (found as Record<string, unknown>[]).find((item) => item.id === target.id)
        : single && (found as { id?: unknown }).id === target.id
          ? found
          : undefined;
  if (record === undefined || record === null) return undefined;
  const version = (record as { version?: unknown }).version;
  return typeof version === "number" ? version : null;
}

/**
 * The version to journal for a target after a write or an undo, read from the state the portal answered
 * with: a number, `null` when the record is gone, undefined when it exists without a version (unguardable).
 */
export function journalVersion(state: PortalState | undefined, target: JournalTarget): number | null | undefined {
  if (!state) return undefined;
  const version = currentVersion(state, target);
  return version === undefined ? null : (version ?? undefined);
}

/**
 * The version to journal after the CLI sent `sent` and the portal answered with `state`, accepted only when it
 * is provably the command's own. The answer is read after the command committed, so another client's edit in
 * between (or, on a retried request answered from its receipt, any edit since) would otherwise be journaled as
 * this command's result, and the opposite move would then overwrite it. A command bumps the record it read
 * exactly once (`expectedVersion + 1`), a create starts the row at 1, and a removal leaves it gone; anything
 * else is undefined, which leaves the entry unguarded so `undo`/`redo` need `--force`.
 */
export function committedVersion(
  state: PortalState | undefined,
  target: JournalTarget,
  sent: Record<string, unknown>
): number | null | undefined {
  const seen = journalVersion(state, target);
  const entity = sent.entity;
  if (entity && typeof entity === "object" && (entity as { remove?: unknown }).remove === true)
    return seen === null ? null : undefined;
  const read = sent.expectedVersion;
  const expected = typeof read === "number" ? read + 1 : read === null ? 1 : undefined;
  return seen === expected ? seen : undefined;
}

/**
 * Records a fresh write: what its owner undid but did not redo can no longer be redone, because that
 * owner's history moved on. Other owners' undone writes stay redoable, and so do the ones the person undid
 * (`undoneBy`): an agent's new write does not take the person's Redo away.
 */
export function recordWrite(journal: Journal, entry: Omit<JournalEntry, "status">): void {
  const kept = journal
    .read()
    .map((item) =>
      item.status === "undone" &&
      item.undoneBy === undefined &&
      (item.owner === undefined || item.owner === entry.owner)
        ? { ...item, status: "superseded" as const }
        : item
    );
  journal.write([...kept, { ...entry, status: "applied" as const }].slice(-(journal.limit ?? JOURNAL_LIMIT)));
}

/**
 * Drops the stored version of every entry other than `except` that targets the same record, whoever owns it,
 * so each needs `--force`. A forced move can delete the record or put it back, and a put-back row starts again
 * at version 1: an old entry's version would then match a different, later state of the record and let its
 * unforced undo overwrite an edit made since.
 */
export function forgetOtherVersions(entries: JournalEntry[], except: number): JournalEntry[] {
  const target = entries[except]?.target;
  if (!target) return entries;
  return entries.map((item, position) => {
    if (position === except || item.target.stateKey !== target.stateKey || item.target.id !== target.id) return item;
    const { version: _dropped, ...rest } = item;
    void _dropped;
    return rest;
  });
}
