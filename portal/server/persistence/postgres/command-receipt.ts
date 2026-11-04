import { createHash } from "node:crypto";
import { changeLogActor } from "@/server/agent-actor";
import { CommandIdReusedError } from "./command-errors";
import type { Sql, TxSql } from "./sql-pool";

/** What identifies a command to its receipt: the id, the owner, the type and the hash of the payload. */
export type CommandReceipt = { id: string; userId: string; commandType: string; requestHash?: string | null };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}

/**
 * Fields the CLI fills from its own clock when it builds a command, per command type: `recalculate` stamps
 * `now`, `disrupt --until +3h` resolves `until` against it, ignoring a capture stamps `entity.reviewedAt`, and a routine run or a disruption derives
 * `entity.startsAt`/`endsAt` (and a disruption `landedAt`) from the time it was run. Repeating a command
 * "with the same --command-id" re-runs the CLI, which stamps a later time; hashed, that would answer 409
 * instead of replaying. They are left out of the hash, so the only reuse that still refuses is a change to
 * a field the caller chose. Paths are relative to the command.
 */
const CLOCK_STAMPED: { type: string; when?: (command: Record<string, unknown>) => boolean; paths: string[] }[] = [
  { type: "recalculate", paths: ["now"] },
  { type: "record_disruption", paths: ["until"] },
  { type: "capture", paths: ["entity.reviewedAt"] },
  {
    type: "commitment",
    when: (c) => entityField(c, "routineSource") === "preset",
    paths: ["entity.startsAt", "entity.endsAt"]
  },
  {
    type: "commitment",
    when: (c) => entityField(c, "origin") === "disruption",
    paths: ["entity.startsAt", "entity.endsAt", "entity.landedAt"]
  }
];

function entityField(command: Record<string, unknown>, name: string): unknown {
  const entity = command.entity;
  return entity && typeof entity === "object" ? (entity as Record<string, unknown>)[name] : undefined;
}

/**
 * Fields the CLI re-reads from the plan each time it runs, for every command type: the version a write expected
 * and the recommendation a session start named. A keyed update lands and bumps the version, the answer is lost,
 * and the honest repeat re-reads the record and sends the new version; hashed, that would answer 409 for a write
 * that already landed. The version is only a guard on the first send, so it is not part of what the write says.
 */
const STATE_READ_TOP = ["expectedVersion", "recommendationId"];
const STATE_READ_RECORDS = ["entity", "project", "action", "rule"];

function withoutClockStamps(commandType: string, payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  for (const field of STATE_READ_TOP) delete copy[field];
  for (const record of STATE_READ_RECORDS) {
    const held = copy[record];
    if (held && typeof held === "object") delete (held as Record<string, unknown>).version;
  }
  for (const rule of CLOCK_STAMPED) {
    if (rule.type !== commandType || (rule.when && !rule.when(payload))) continue;
    for (const path of rule.paths) {
      const [head, tail] = path.split(".");
      const holder = tail === undefined ? copy : copy[head!];
      if (holder && typeof holder === "object") delete (holder as Record<string, unknown>)[tail ?? head!];
    }
  }
  return copy;
}

/**
 * SHA-256 of the command as the receipt remembers it: its type plus its payload with the keys sorted at every
 * depth and `commandId` left out (the id is what the receipt is keyed by, and a repeat names it again).
 * Two sends of one write hash alike whatever order the client wrote the keys in; a different payload or a
 * different type does not.
 */
export function commandRequestHash(commandType: string, command: object): string {
  const { commandId: _commandId, ...rest } = command as Record<string, unknown>;
  const payload = withoutClockStamps(commandType, rest);
  return createHash("sha256")
    .update(JSON.stringify(canonical({ type: commandType, payload })))
    .digest("hex");
}

const REUSED = "This command id was already used for a different write; use a new command id.";

/** Throws when the receipt on file for this id belongs to a different write. A row from before hashes (null) matches anything. */
export function refuseCommandIdReuse(
  stored: { command_type: string; request_hash: string | null },
  receipt: Pick<CommandReceipt, "commandType" | "requestHash">
): void {
  if (stored.command_type !== receipt.commandType) throw new CommandIdReusedError(REUSED);
  if (receipt.requestHash && stored.request_hash && stored.request_hash !== receipt.requestHash)
    throw new CommandIdReusedError(REUSED);
}

/**
 * The cheap replay check every `run*Command` makes before opening its transaction: whether this id already
 * has a receipt. True means the command already landed (return the current state). An id that has a receipt
 * for a different write throws `CommandIdReusedError` (409) instead of silently replaying and dropping this one.
 */
export async function hasCommandReceipt(sql: Sql, receipt: CommandReceipt): Promise<boolean> {
  const rows = await sql<
    { command_type: string; request_hash: string | null }[]
  >`SELECT command_type, request_hash FROM writes WHERE id=${receipt.id} AND user_id=${receipt.userId}`;
  if (!rows[0]) return false;
  refuseCommandIdReuse(rows[0], receipt);
  return true;
}

/**
 * Takes the `writes` row (the ledger header, which is also the receipt) for a command inside the command's own transaction. Returns true when this call
 * took it (go on and apply the command), false when the receipt already exists (the command already
 * landed: skip the writes and replay by returning the current state).
 *
 * Every `run*Command` first looks for a receipt outside the transaction as a cheap replay check
 * (`hasCommandReceipt`), but that select cannot see a request racing its own retry: both pass it, and a plain insert would make
 * the loser fail with a 23505 unique violation (a 500) for a write that landed. `ON CONFLICT DO NOTHING`
 * waits on the winner's insert and then reports no row, which is an applied replay, not an error. The
 * loser still compares what the winner stored, so a different write under the same id is refused here too.
 */
export async function claimCommandReceipt(tx: TxSql, receipt: CommandReceipt): Promise<boolean> {
  const claimed = await tx<
    { id: string }[]
  >`INSERT INTO writes (id, user_id, command_type, request_hash, actor) VALUES (${receipt.id}, ${receipt.userId}, ${receipt.commandType}, ${receipt.requestHash ?? null}, ${changeLogActor()}) ON CONFLICT (id) DO NOTHING RETURNING id`;
  if (claimed.length > 0) return true;
  const stored = await tx<
    { command_type: string; request_hash: string | null }[]
  >`SELECT command_type, request_hash FROM writes WHERE id=${receipt.id} AND user_id=${receipt.userId}`;
  if (stored[0]) refuseCommandIdReuse(stored[0], receipt);
  return false;
}
