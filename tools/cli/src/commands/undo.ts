import { booleanOption, stringOption, type CommandContext, type CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { toJson } from "../output.js";
import { UNLABELED_OWNER } from "../agent.js";
import type { PortalState } from "../client.js";
import {
  canRecreate,
  committedVersion,
  currentVersion,
  forgetOtherVersions,
  type JournalEntry,
  type JournalStatus
} from "../undo-journal.js";
import { isFiledProposal, newCommandId, reportFiledProposal, sendCommand } from "../write.js";

type Direction = "undo" | "redo";

/** What a remote `/mcp` agent can do about a refused undo: it has no `--force`, and the portal refuses it one. */
const REMOTE_ALTERNATIVE = "Ask the owner to undo it from Review > Agent changes, or make a fresh save.";

/** An agent on the portal's remote `/mcp`: it cannot pass `--force`, and the owner's in-process runs can. */
function remoteAgent(context: CommandContext): boolean {
  return context.remote === true && context.byOwner !== true;
}

/** The way past a refusal: `--force` for a person at the CLI, the owner or a fresh save for a remote agent. */
function wayPast(context: CommandContext, direction: Direction, forced: string): string {
  return remoteAgent(context) ? REMOTE_ALTERNATIVE : `Pass --force to ${direction} it anyway${forced}`;
}

interface Flags {
  /** Reverse another owner's write. */
  anyOwner: boolean;
  /** Reverse a write whose record changed since, or that was recorded without a version to check. */
  force: boolean;
  /** Reverse this one journal entry rather than the newest of its owner's. */
  id?: string | undefined;
}

/**
 * The entry `undo` reverses (the newest applied) or `redo` reapplies (the one undone last, so a run of undos
 * is redone in the opposite order; entries undone before undos were numbered fall back to journal order).
 * Only the caller's own entries count, and entries from before owners were recorded (which belong to no
 * one we can name) match any caller and are left to the version check below. Someone else's entries are
 * skipped, so the caller reaches their own older write; only when they have none is it an error naming the
 * newest foreign one, unless `--any-owner` says to take it. Ownership guards against accidents; it is a label
 * the caller chooses (`--agent`), not a security boundary.
 */
function pick(entries: JournalEntry[], direction: Direction, owner: string, anyOwner: boolean): number {
  const wanted: JournalStatus = direction === "undo" ? "applied" : "undone";
  // What the person undid is theirs to put back: the newest-first pick never reaches it (`--id --any-owner` does).
  const order = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.status === wanted && entry.undoneBy === undefined)
    .sort((a, b) =>
      direction === "redo" ? (b.entry.undoSeq ?? -1) - (a.entry.undoSeq ?? -1) || b.index - a.index : b.index - a.index
    );
  let foreign: JournalEntry | undefined;
  for (const { entry, index } of order) {
    if (anyOwner || entry.owner === undefined || entry.owner === owner) return index;
    foreign ??= entry;
  }
  if (foreign)
    throw new CliError(
      `Nothing of yours to ${direction}: the recorded writes to ${direction} are all someone else's (the newest, ` +
        `"${foreign.label}", was made by ${foreign.owner}, and you are ${owner}). Pass --any-owner to ${direction} it anyway.`,
      EXIT.usage
    );
  return -1;
}

/**
 * The entry named by `--id`: `undo` takes it only while applied, `redo` only while undone. The owner rule is the
 * same as for the newest entry (`--any-owner` overrides). The version checks in `apply` still decide whether the
 * record can be put back, so naming an older entry whose record was edited since is refused, not forced.
 */
function pickById(entries: JournalEntry[], id: string, direction: Direction, owner: string, anyOwner: boolean): number {
  const index = entries.findIndex((entry) => entry.id === id);
  const entry = entries[index];
  if (!entry)
    throw new CliError(
      `No recorded write has the id ${id}. \`rhen undo --list\` shows the ids; the journal keeps only the latest writes.`,
      EXIT.notFound
    );
  const wanted: JournalStatus = direction === "undo" ? "applied" : "undone";
  if (entry.status !== wanted) {
    const why =
      entry.status === "superseded"
        ? "it can no longer be reversed or reapplied (a later write moved on, or its record is gone)"
        : entry.status === "applied"
          ? "it has not been undone, so there is nothing to redo"
          : "it is already undone; use --redo to put it back";
    throw new CliError(`Cannot ${direction} "${entry.label}" (${id}): ${why}.`, EXIT.conflict);
  }
  if (!anyOwner && entry.undoneBy === "owner")
    throw new CliError(
      `Not redone: "${entry.label}" was undone by the person, so only they can put it back.`,
      EXIT.usage
    );
  if (!anyOwner && entry.owner !== undefined && entry.owner !== owner)
    throw new CliError(
      `Not ${direction === "undo" ? "undone" : "redone"}: "${entry.label}" was made by ${entry.owner}, and you are ${owner}. ` +
        `Pass --any-owner to ${direction} it anyway.`,
      EXIT.usage
    );
  return index;
}

/**
 * The entry whose write the record is back at after entry `index` is undone: the nearest older applied entry
 * for the same record, when it has the same owner and nothing touched the record between the two writes.
 * Undoing restores the record as it was just before the write, so if someone edited it after the older write
 * that edit would come back with it, and the older write's own undo would then overwrite it. The write sent the
 * version it read (`expectedVersion`, which the portal enforces); it must equal what the older write left. When
 * the write sent no version, or the older entry has none, the link cannot be proved and nothing is refreshed.
 * -1 when there is no entry to refresh.
 */
function previousApplied(entries: JournalEntry[], index: number): number {
  const entry = entries[index];
  if (!entry) return -1;
  for (let position = index - 1; position >= 0; position -= 1) {
    const older = entries[position];
    if (older?.status !== "applied") continue;
    if (older.target.stateKey !== entry.target.stateKey || older.target.id !== entry.target.id) continue;
    if (older.owner !== entry.owner) return -1;
    const readBefore = entry.redo.payload.expectedVersion;
    return typeof readBefore === "number" && older.version === readBefore ? position : -1;
  }
  return -1;
}

/**
 * The entry whose redo comes next for the same record once entry `index` is redone: the one undone just before it,
 * when it has the same owner and nothing else touched the record between the two undos. Redoing puts the record
 * back as the earlier write left it, at a new version, and that entry's stored version is the one its own undo
 * left, so without this its redo would report an edit that never happened. This entry's undo recorded the version
 * it read; that being the version the other's undo left proves nothing came between them, including when this
 * undo deleted the record (an undone add) and the redo recreates it at version 1. Entries undone before that was
 * recorded fall back to the undo having bumped the version exactly once. -1 when the link cannot be proved.
 */
function previousUndone(entries: JournalEntry[], index: number): number {
  const entry = entries[index];
  const sequence = entry?.undoSeq;
  if (!entry || sequence === undefined) return -1;
  let found = -1;
  let foundSequence = -1;
  entries.forEach((other, position) => {
    const otherSequence = other.undoSeq;
    if (position === index || other.status !== "undone" || otherSequence === undefined) return;
    if (otherSequence >= sequence || otherSequence <= foundSequence) return;
    if (other.target.stateKey !== entry.target.stateKey || other.target.id !== entry.target.id) return;
    found = position;
    foundSequence = otherSequence;
  });
  const earlier = entries[found];
  if (!earlier || earlier.owner !== entry.owner) return -1;
  if (typeof earlier.version !== "number") return -1;
  if (entry.undoReadVersion !== undefined) return entry.undoReadVersion === earlier.version ? found : -1;
  return entry.version === earlier.version + 1 ? found : -1;
}

/**
 * Reverses (or reapplies) a write the portal snapshotted, by posting the entry's request to the portal's revert
 * route. The portal compares the rows the write touched with what they are now and refuses when anything
 * changed since, so none of the client-side version logic below applies: no state read, no `expectedVersion`.
 * `--force` is passed on, and the portal honours it only for the owner (an agent is refused). A 404 means the portal no longer holds the snapshot (it keeps
 * the newest 500 per person), so the entry can never be reversed and is dropped, like a vanished record.
 */
async function applyServerChecked(
  context: CommandContext,
  flags: Flags,
  dryRun: boolean,
  direction: Direction,
  entries: JournalEntry[],
  index: number
): Promise<void> {
  const journal = context.journal!;
  const entry = entries[index]!;
  const past = direction === "undo" ? "undone" : "redone";
  const request = direction === "undo" ? entry.undo : entry.redo;
  const payload = { ...request.payload, commandId: newCommandId(), ...(flags.force ? { force: true } : {}) };
  context.stderr(`rhen: ${direction} "${entry.label}"`);
  if (dryRun) {
    context.stdout(toJson({ dryRun: true, path: request.path, payload }, true));
    return;
  }
  let response: unknown;
  try {
    response = await sendCommand<unknown>(context.client, request.path, payload);
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT.conflict)
      throw new CliError(
        `Not ${past}: "${entry.label}". ${error.message}${
          flags.force || (remoteAgent(context) && error.message.includes(REMOTE_ALTERNATIVE))
            ? ""
            : " " + wayPast(context, direction, " if it was edited since.")
        }`,
        EXIT.conflict,
        error.details
      );
    if (error instanceof CliError && error.exitCode === EXIT.notFound) {
      journal.write(entries.map((item, position) => (position === index ? { ...item, status: "superseded" } : item)));
      throw new CliError(
        `Cannot ${direction} "${entry.label}": the portal no longer holds what that write changed (it keeps the newest ` +
          `500). The entry is dropped from the journal (it shows as superseded in \`undo --list\`); run ` +
          `\`rhen undo${direction === "redo" ? " --redo" : ""}\` again for the next one. (${error.message})`,
        EXIT.notFound
      );
    }
    throw error;
  }
  if (isFiledProposal(response)) {
    reportFiledProposal(context, response);
    return;
  }
  const sequence = Math.max(0, ...entries.map((item) => item.undoSeq ?? 0)) + 1;
  journal.write(
    entries.map((item, position) => {
      if (position !== index) return item;
      const next: JournalEntry = { ...item, status: direction === "undo" ? "undone" : "applied" };
      if (direction === "undo") next.undoSeq = sequence;
      else delete next.undoSeq;
      if (direction === "undo" && context.byOwner === true) next.undoneBy = "owner";
      else delete next.undoneBy;
      return next;
    })
  );
  reportDone(context, entry, direction);
}

function reportDone(context: CommandContext, entry: JournalEntry, direction: Direction): void {
  const message =
    direction === "undo" ? `Undone: ${entry.label}. Run \`rhen redo\` to put it back.` : `Redone: ${entry.label}.`;
  if (context.mode !== "table") context.stdout(toJson({ ok: true, direction, id: entry.id, label: entry.label }, true));
  else context.stdout(message);
}

async function apply(context: CommandContext, flags: Flags, dryRun: boolean, direction: Direction): Promise<void> {
  const journal = context.journal;
  const entries = journal?.read() ?? [];
  const owner = context.owner ?? UNLABELED_OWNER;
  const index =
    flags.id === undefined
      ? pick(entries, direction, owner, flags.anyOwner)
      : pickById(entries, flags.id, direction, owner, flags.anyOwner);
  const entry = entries[index];
  if (!journal || !entry)
    throw new CliError(
      direction === "undo"
        ? 'Nothing to undo: no reversible write is recorded. Only writes made through this CLI/MCP that say "undo with" are recorded.'
        : "Nothing to redo: redo only follows an undo, and a new write clears it.",
      EXIT.notFound
    );
  if (entry.serverChecked === true) return applyServerChecked(context, flags, dryRun, direction, entries, index);
  const past = direction === "undo" ? "undone" : "redone";
  const request = direction === "undo" ? entry.undo : entry.redo;
  const state = await context.client.getState();
  const current = currentVersion(state, entry.target);
  // `entry.version` is what the last journaled write left the record at. Anything else now means someone
  // edited it since, and putting the old record back would overwrite that edit.
  const guard = entry.version;
  // The record is gone though the write left it standing. Only a request that restates the whole record puts
  // it back (with `--force`, which then sends `expectedVersion: null`); for anything else no flag helps.
  // That entry can never be reversed, so it is dropped from the journal (`superseded`, shown by `--list`):
  // left on top it would block every older entry, as `undo` always takes the newest.
  if (current === undefined && guard !== null && !canRecreate(request)) {
    if (!dryRun)
      journal.write(entries.map((item, position) => (position === index ? { ...item, status: "superseded" } : item)));
    throw new CliError(
      `Cannot ${direction} "${entry.label}": the record it changed no longer exists, and ${direction === "undo" ? "restoring" : "reapplying"} ` +
        "it cannot bring it back. The entry is dropped from the journal (it shows as superseded in `undo --list`); " +
        `run \`rhen undo${direction === "redo" ? " --redo" : ""}\` again for the next one.`,
      EXIT.notFound
    );
  }
  if (!flags.force) {
    if (guard === undefined)
      throw new CliError(
        `Not ${past}: "${entry.label}" was recorded without the record's version (by an older CLI, the portal did not ` +
          `show it, the version after the write was not the write's own, so it may have included another edit, or a ` +
          `forced undo or redo of the same record has run since), ` +
          `so there is no way to tell whether it changed since. ` +
          wayPast(context, direction, ", overwriting anything changed in the meantime."),
        EXIT.conflict
      );
    if (guard === null ? current !== undefined : current !== guard)
      throw new CliError(
        `Not ${past}: "${entry.label}" changed since it was written (version ${guard ?? "none"}, now ${current ?? "gone"}), ` +
          `so ${direction === "undo" ? "restoring" : "reapplying"} it would overwrite that change. ` +
          (remoteAgent(context)
            ? REMOTE_ALTERNATIVE
            : `Look at the record and edit it by hand, or pass --force to ${direction} it anyway.`),
        EXIT.conflict
      );
  }
  const expectedVersion = flags.force || guard === undefined ? (current ?? null) : guard;
  const payload = { ...request.payload, commandId: newCommandId(), expectedVersion };
  context.stderr(`rhen: ${direction} "${entry.label}"`);
  if (dryRun) {
    context.stdout(toJson({ dryRun: true, path: request.path, payload }, true));
    return;
  }
  let response: { state?: PortalState } | undefined;
  try {
    response = await sendCommand<{ state?: PortalState } | undefined>(context.client, request.path, payload);
  } catch (error) {
    // The portal's own version check lost a race with an edit between our read and our write.
    if (error instanceof CliError && error.exitCode === EXIT.conflict)
      throw new CliError(
        `Not ${past}: "${entry.label}" changed since it was written, so nothing was overwritten. (${error.message})`,
        EXIT.conflict,
        error.details
      );
    throw error;
  }
  if (isFiledProposal(response)) {
    // Held for the owner: nothing moved, so the journal stays as it was.
    reportFiledProposal(context, response);
    return;
  }
  // The version the reversal left is what the opposite move (redo after undo, undo after redo) must match; kept
  // only when provably the reversal's own (see `committedVersion`), else the opposite move needs `--force`.
  const version = committedVersion(response?.state, entry.target, payload);
  // Undoing puts the record back as the previous journaled write left it, at the version the undo just made.
  // That previous write's entry still holds the version it saw, so without this the repeat `undo` would report
  // an edit that never happened. Only done when the version check passed (a forced undo may have skipped past
  // a real edit) and only for the entry directly below, if it is the same owner's: another owner's write in
  // between means the record is in their state, not this owner's.
  const below = direction === "undo" && !flags.force && version !== undefined ? previousApplied(entries, index) : -1;
  // The same for a redo: the entry undone just before this one now follows it again, at the version it left.
  const above = direction === "redo" && !flags.force && version !== undefined ? previousUndone(entries, index) : -1;
  const sequence = Math.max(0, ...entries.map((item) => item.undoSeq ?? 0)) + 1;
  const moved = entries.map((item, position) => {
    if ((position === below || position === above) && version !== undefined) return { ...item, version };
    if (position !== index) return item;
    const next: JournalEntry = { ...item, status: direction === "undo" ? "undone" : "applied" };
    if (direction === "undo") next.undoSeq = sequence;
    else delete next.undoSeq;
    // Who undid it decides who may redo it; any redo clears the mark.
    if (direction === "undo" && context.byOwner === true) next.undoneBy = "owner";
    else delete next.undoneBy;
    // A checked undo read the record at `expectedVersion`; `previousUndone` links on it when this is redone.
    if (direction === "undo" && !flags.force && typeof expectedVersion === "number")
      next.undoReadVersion = expectedVersion;
    else delete next.undoReadVersion;
    if (version === undefined) delete next.version;
    else next.version = version;
    // A checked redo read the record at the version the undo left (`expectedVersion`), which is what this
    // write now reads before it; record that, so undoing it again can still tell it follows the older entry.
    if (direction === "redo" && !flags.force && version !== undefined)
      next.redo = { ...item.redo, payload: { ...item.redo.payload, expectedVersion } };
    return next;
  });
  // A forced move may have removed the record or put it back, which restarts its version at 1 (see
  // `forgetOtherVersions`); every other entry for it then needs `--force` too.
  journal.write(flags.force ? forgetOtherVersions(moved, index) : moved);
  reportDone(context, entry, direction);
}

export const undoCommand: CommandSpec = {
  name: "undo",
  summary: "Reverse your latest recorded write (--redo reapplies it)",
  description:
    'Reverses your most recent write that said "undo with rhen undo" (a save, bulk edit, skip-step/unskip-step, pause/resume, arrive, review keep, recurrence, cadence ' +
    "or activity write, wake, disrupt, disruption, re-entry, session, check-in, catch-up settle, archive, cancel or restore, or Inbox confirm as an agent), restoring the rows it touched " +
    "exactly as they were (a record the write added is removed, a field it added goes). The portal does it from the " +
    "rows it kept, only while nothing the write touched has changed since; --redo puts it back. A write made without " +
    "an agent token (the person's own, at a terminal) is restated from the record as it was instead: a new area, " +
    "outcome, project, action, commitment, routine preset or context is taken out of the plan by setting its status " +
    "(archived for an area, routine preset or context, cancelled for the rest), a new capture is ignored (needs " +
    "write:inbox), and a new span is removed. Repeat to go back " +
    "further. --redo reapplies the write you just undid, until a new write is made. --list shows what is recorded. " +
    "--id <entry-id> reverses that one recorded write (with --redo, reapplies it if it is undone) instead of the newest; the same owner and version checks apply. " +
    "--force reverses a write the portal kept rows for even if they changed since, for the owner only. " +
    "Each applied row of a bulk edit is recorded on its own, so each undo reverses one row. " +
    "Writes the portal keeps no rows for (a deliverable, an email, imports) are not recorded. " +
    "Only your own writes are reversed (your token, else your --agent name, else the unlabeled owner, as the portal names the actor); " +
    "--any-owner reverses another's. Someone else's newer writes are skipped, not refused. If the record was edited after the write, nothing is overwritten and undo " +
    "says so; --force reverses anyway, and is also needed for writes recorded by an older CLI, whose version cannot be checked.",
  positionals: [],
  options: {
    redo: { type: "boolean", description: "Reapply the write you last undid" },
    list: { type: "boolean", description: "Show recorded writes instead of undoing" },
    id: {
      type: "string",
      description: "Reverse this one recorded write (an id from --list or the Agent changes list)"
    },
    "any-owner": { type: "boolean", description: "Reverse a write made by another agent or token" },
    force: {
      type: "boolean",
      description: "Reverse even if the record changed since, or the write was recorded without a version to check"
    },
    "dry-run": { type: "boolean", description: "Print the command instead of sending it" }
  },
  mutates: true,
  destructive: true,
  idempotent: false,
  examples: ["undo", "undo --redo", "undo --list", "undo --id <entry-id>", "undo --any-owner"],
  async run(context, args) {
    if (booleanOption(args.values, "list")) {
      const entries = [...(context.journal?.read() ?? [])].reverse();
      if (context.mode !== "table")
        context.stdout(
          toJson(
            entries.map(({ id, at, label, status, owner }) => ({ id, at, label, status, owner: owner ?? null })),
            true
          )
        );
      else
        context.stdout(
          entries.length === 0
            ? "No reversible writes recorded."
            : entries
                .map((e) => `${e.status.padEnd(10)} ${e.at}  ${e.label}  [${e.owner ?? "unknown owner"}]`)
                .join("\n")
        );
      return;
    }
    await apply(
      context,
      {
        anyOwner: booleanOption(args.values, "any-owner"),
        force: booleanOption(args.values, "force"),
        id: stringOption(args.values, "id")
      },
      booleanOption(args.values, "dry-run"),
      booleanOption(args.values, "redo") ? "redo" : "undo"
    );
  }
};
