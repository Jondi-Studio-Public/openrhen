import {
  aliasTitleNorm,
  calendarSourceConnections,
  type SourceProvider,
  type SplitCommitmentSourceCommand
} from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { CommandConflictError, InvalidCommandError, notFoundConflict, versionConflict } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import { googleEventKey } from "./imports/calendar-profiles/calendar";
import { isPrimarySource } from "./imports/primary-source";
import { extensionLinkImportKey, extensionSourceTypeOf } from "./imports/import-extensions";
import "./imports/private/index";
import { unlinkSource } from "./imports/source-links";
import { recordStateChange } from "./planning-evidence";
import type { PoolSql } from "./sql-pool";
import { readStateAfterCommit } from "./read-after-commit";

/**
 * **Not the same event**: a secondary source link that
 * was matched to the wrong commitment leaves it and becomes the commitment its own event describes,
 * in one transaction. The link moves with the event, so the next import finds it already linked
 * rather than matching it back onto the commitment it was just taken from.
 */

/** What a source's last snapshot says about its event, enough to build a commitment. */
export interface SnapshotCommitmentFields {
  title: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
}

/**
 * The commitment a link's `last_remote_snapshot` describes, or `null` when the snapshot does not carry
 * a title and a valid start and end. Every provider's snapshots all store `title`,
 * `startsAt`, `endsAt` and `location`; a provider whose snapshot lacks them is unlinked without a new
 * commitment, since inventing one would be worse than none.
 */
export function commitmentFieldsFromSnapshot(snapshot: unknown): SnapshotCommitmentFields | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const record = snapshot as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title || typeof record.startsAt !== "string" || typeof record.endsAt !== "string") return null;
  const startsAt = new Date(record.startsAt);
  const endsAt = new Date(record.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) return null;
  const location = typeof record.location === "string" && record.location.trim() ? record.location.trim() : null;
  return { title, startsAt, endsAt, location };
}

/**
 * The `import_entity_keys` key the import commit wrote for this link's event, which later update and
 * delete records resolve through: `google_calendar:event:<googleEventKey>`, or the one an import extension gives
 * its provider (`<provider>:event:<id>`) (a Google link's frame is its calendar). `null` for a
 * provider no diff keys yet.
 */
export function linkImportKey(provider: SourceProvider, frameId: string, externalEventId: string): string | null {
  if (provider === "google_calendar") return `google_calendar:event:${googleEventKey(frameId, externalEventId)}`;
  return extensionLinkImportKey(provider, frameId, externalEventId);
}

/** The `sources.source_type` each provider's import writes, for moving a commitment's provenance row. */
function sourceTypeOf(provider: SourceProvider): string | undefined {
  return (
    calendarSourceConnections().find((manifest) => manifest.id === provider)?.calendarSource?.sourceType ??
    extensionSourceTypeOf(provider)
  );
}

interface LinkRow {
  id: string;
  provider: SourceProvider;
  role: "primary" | "secondary";
  frame_id: string;
  external_event_id: string;
  profile_label: string;
  source_calendar_id: string | null;
  last_remote_snapshot: unknown;
  last_remote_hash: string;
}

export async function splitCommitmentSource(sql: PoolSql, command: SplitCommitmentSourceCommand): Promise<PortalState> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash("split_commitment_source", command);
  if (
    await hasCommandReceipt(sql, { id: command.commandId, userId, commandType: "split_commitment_source", requestHash })
  )
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    if (
      !(await claimCommandReceipt(tx, {
        id: command.commandId,
        userId,
        commandType: "split_commitment_source",
        requestHash
      }))
    )
      return;
    const commitments = await tx<
      { version: number; title: string; source_id: string | null }[]
    >`SELECT version,title,source_id FROM commitments WHERE id=${command.commitmentId} AND user_id=${userId} FOR UPDATE`;
    if (!commitments[0]) throw notFoundConflict("commitment", command.commitmentId);
    if (commitments[0].version !== command.expectedVersion)
      throw versionConflict("commitment", command.commitmentId, command.expectedVersion, commitments[0].version);
    const links = await tx<LinkRow[]>`
      SELECT id,provider,role,frame_id,external_event_id,profile_label,source_calendar_id,last_remote_snapshot,last_remote_hash
      FROM calendar_event_links WHERE user_id=${userId} AND commitment_id=${command.commitmentId} ORDER BY created_at,id`;
    const link = links.find((row) => row.id === command.linkId);
    if (!link)
      throw new CommandConflictError(
        `Source link "${command.linkId}" is no longer attached to commitment "${command.commitmentId}". Nothing was changed.`,
        {
          nextCall: {
            tool: "rhen_show",
            arguments: { entity: "commitment", id: command.commitmentId },
            note: "lists the sources still linked"
          }
        }
      );
    if (link.role === "primary") throw new InvalidCommandError("The primary source cannot be split off.");
    if (links.length < 2)
      throw new InvalidCommandError("This is the commitment's only source; there is nothing to split it from.");

    const fields = commitmentFieldsFromSnapshot(link.last_remote_snapshot);
    let createdId: string | null = null;
    if (fields) {
      const created = await tx<{ id: string }[]>`
        INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,location,setup_before_minutes,transition_after_minutes)
        VALUES (gen_random_uuid(),${userId},${fields.title},${fields.startsAt},${fields.endsAt},'confirmed',${fields.location},0,0)
        RETURNING id`;
      createdId = created[0]!.id;
      // The link row itself moves, keeping its id, snapshot and hash, so the next diff compares against
      // exactly what this source last said.
      await tx`UPDATE calendar_event_links SET commitment_id=${createdId},updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId} AND id=${link.id}`;
    } else {
      await unlinkSource(tx, { userId, linkId: link.id });
    }
    await recordStateChange(tx, userId, {
      entityType: "commitment",
      entityId: createdId ?? command.commitmentId,
      operation: "split_source",
      evidence: {
        fromCommitmentId: command.commitmentId,
        provider: link.provider,
        createdCommitment: createdId !== null
      },
      commandId: command.commandId,
      at: new Date()
    });
    const key = linkImportKey(link.provider, link.frame_id, link.external_event_id);
    if (key) {
      // The commit's `link` record keyed this event to the commitment it joined, and later update and
      // delete records resolve through that key: left alone, a moved or deleted copy would move or
      // delete the original. It follows the event to its own commitment, or goes when there is none.
      if (createdId)
        await tx`INSERT INTO import_entity_keys (user_id,entity_type,import_key,entity_id) VALUES (${userId},'fixed_commitment',${key},${createdId}) ON CONFLICT (user_id,entity_type,import_key) DO UPDATE SET entity_id=EXCLUDED.entity_id,updated_at=CURRENT_TIMESTAMP`;
      else
        await tx`DELETE FROM import_entity_keys WHERE user_id=${userId} AND entity_type='fixed_commitment' AND import_key=${key} AND entity_id=${command.commitmentId}`;
    }
    // The departed source's provenance row goes with it. The original falls back to a remaining primary
    // source's row, else none. A source row that no link implies (email, Google) is left where it is.
    const departedType = sourceTypeOf(link.provider);
    if (departedType && commitments[0].source_id) {
      const owned = await tx<
        { source_type: string }[]
      >`SELECT source_type FROM sources WHERE id=${commitments[0].source_id} AND user_id=${userId}`;
      if (owned[0]?.source_type === departedType) {
        if (createdId) await tx`UPDATE commitments SET source_id=${commitments[0].source_id} WHERE id=${createdId}`;
        const remaining = links.find((row) => isPrimarySource(row.provider));
        await tx`UPDATE commitments SET source_id=(SELECT id FROM sources WHERE user_id=${userId} AND source_type=${remaining ? (sourceTypeOf(remaining.provider) ?? null) : null} AND external_id=${remaining?.external_event_id ?? null}) WHERE id=${command.commitmentId}`;
      }
    }
    // A remembered "Same event" alias pairing this source's title with the original's would strong-match
    // next week's copy straight back onto it.
    const snapshotTitle = (link.last_remote_snapshot as { title?: unknown } | null)?.title;
    if (typeof snapshotTitle === "string")
      await tx`DELETE FROM source_match_aliases WHERE user_id=${userId} AND provider=${link.provider} AND remote_title_norm=${aliasTitleNorm(snapshotTitle)} AND local_title_norm=${aliasTitleNorm(commitments[0].title)}`;
  });
  return await readStateAfterCommit(sql);
}
