import { notFoundRefusal, refusalText } from "@openrhen/contracts";
import {
  calendarSourceConnections,
  importBatchSchema,
  type ImportBatch,
  type CalendarEvent,
  type ImportRecord,
  type PreviewImport
} from "@openrhen/contracts";
import { importBatches, importEntityKeys, userPreferences } from "@openrhen/database";
import { deferWithBlockedTargets } from "@/server/imports/commit-split";
import {
  fallbackReferenceKey,
  type ReferenceKeyCandidate,
  type ReferenceKeyMap
} from "@/server/imports/reference-keys";
import { requestAgent } from "@/server/agent-actor";
import { databaseUrl } from "@/server/runtime-env";
import type { Row } from "./db-row";
import { ensureUser } from "./state-store";
import { claimCommandReceipt } from "./command-receipt";
import { CommandConflictError, ForbiddenCommandError } from "./command-errors";
import { recordStateChange } from "./planning-evidence";
import { sqlPool, type PoolSql, type Sql } from "./sql-pool";
import {
  batchSource,
  batchStatus,
  findOpenBatchByHash,
  insertBatch,
  isUniqueViolation,
  mapBatch,
  mapRecord,
  OPEN_IMPORT_BATCH_STATUSES,
  writeRecords
} from "./imports/batch-records";
import { agentImportFloor, closingRecordCount } from "./imports/agent-import-floor";
import { assertCloseBudget, closeBudgetApplies, lockCloseBudget } from "./close-budget";
import { commitRecords } from "./imports/commit-records";
import { importExtensions, isExtensionSourceType, type ExtensionLinkSource } from "./imports/import-extensions";
import "./imports/private/index";
// The calendar feed is core, so it registers beside the private seam, not inside it.
import "./imports/calendar-feed-import-extension";
import { installStoreMethods } from "./imports/store-methods";
import { loadCommitmentLinks, loadMatchContext } from "./imports/source-links";
import {
  calendarDiffRecords,
  findProfile,
  profileFor,
  type CalendarDismissalRow,
  type CalendarLinkRow
} from "./imports/calendar-diff";
import { googleCalendarSourceText, type GoogleCalendarSource } from "./imports/calendar-profiles/calendar";
import { ImportConflictError } from "./imports/import-conflict-error";
import { deferPairPartners, splitFeedMovePair } from "./imports/feed-move-pairs";
import { resolveOperations } from "./imports/key-resolution";
import {
  recordCalendarDismissals,
  releaseKeptCalendarLinks,
  declinedDeleteDismissals,
  type LocationRow
} from "./imports/calendar-diff-core";

export { ImportConflictError } from "./imports/import-conflict-error";

/**
 * The lifecycle of an import batch — preview, save, commit, delete — as one object over the
 * database. Each step's substance lives in `./imports/`: how records are stored (`batch-records`),
 * how keys resolve to what exists (`key-resolution`), how a calendar is diffed (`calendar-diff`, with a
 * profile per kind of source), how ready records are written (`commit-records`, `upserts`). This class holds
 * the transactions and the version checks that tie them together.
 */
export class PostgresImportStore {
  constructor(readonly sql: PoolSql) {}

  async preview(input: PreviewImport): Promise<ImportBatch> {
    return (await this.previewOrReopen(input)).batch;
  }

  /**
   * Persists a preview as a new batch — unless the same content is already waiting. A batch that is
   * still open (previewed, not committed, not deleted) with the same content hash and the same source
   * type is that file's batch, and uploading the file again reopens it rather than adding a twin to
   * the queue. `reopened` tells the caller which happened, so the user can be told. Batches without a
   * hash (AI extraction, the calendar provider) always create.
   *
   * A reopened batch is re-resolved against the database as it now stands rather than handed back as
   * it was last left: the rows it validates against — areas, projects, contexts, whatever else it
   * references — can have moved on since it was previewed, so serving its old statuses could show
   * "ready" for a batch that would now fail honestly at commit.
   *
   * Two uploads of the same file racing each other can both pass the open-batch lookup before either
   * has committed its insert. `import_batches_open_content_unique` (a partial unique index over open
   * statuses) turns the loser's insert into a unique violation instead of a silent duplicate draft;
   * the loser then simply reopens whichever batch won.
   */
  async previewOrReopen(input: PreviewImport): Promise<{ batch: ImportBatch; reopened: boolean }> {
    const userId = await ensureUser(this.sql);
    let batchId = "";
    let reopened = false;
    try {
      await this.sql.begin(async (tx) => {
        const existing = input.source.contentHash
          ? await findOpenBatchByHash(tx, userId, input.sourceType, input.source.contentHash)
          : null;
        if (existing) {
          batchId = existing;
          reopened = true;
          await this.refreshStoredRecords(tx, userId, batchId);
          return;
        }
        const records = await resolveOperations(tx, userId, input.records);
        batchId = await insertBatch(tx, userId, input, records);
      });
    } catch (error) {
      if (!isUniqueViolation(error) || !input.source.contentHash) throw error;
      const existing = await findOpenBatchByHash(this.sql, userId, input.sourceType, input.source.contentHash);
      if (!existing) throw error;
      batchId = existing;
      reopened = true;
    }
    return { batch: (await this.get(batchId))!, reopened };
  }

  /** Re-resolves a batch's own stored records against the database and writes the fresh result back. */
  private async refreshStoredRecords(tx: Sql, userId: string, batchId: string): Promise<void> {
    const raw = await tx<any[]>`SELECT * FROM import_records WHERE batch_id=${batchId} ORDER BY sort_order, id`;
    const refreshed = await resolveOperations(tx, userId, raw.map(mapRecord));
    await tx`DELETE FROM import_records WHERE batch_id=${batchId}`;
    await writeRecords(tx, batchId, refreshed);
    await tx`UPDATE import_batches SET status=${batchStatus(refreshed)}, updated_at=CURRENT_TIMESTAMP WHERE id=${batchId}`;
  }

  /**
   * Diffs the events read from the chosen Google calendars against the events already linked to a fixed
   * commitment, in one pass (creates, updates, conflicts and deletes together), and returns the records
   * with a way to build a preview from any subset of them. The automatic sync splits that set: updates
   * and deletes to linked events apply on their own, creates and conflicts are held for review; a manual
   * preview (`previewGoogleCalendar`) keeps them all in one batch.
   */
  async diffGoogleCalendar(args: {
    timezone: string;
    timeMin: string;
    timeMax: string;
    events: CalendarEvent[];
    calendars: { calendarId: string; summary: string }[];
  }): Promise<{ records: ImportRecord[]; previewFor: (records: ImportRecord[]) => PreviewImport }> {
    const userId = await ensureUser(this.sql);
    const defaults = await this.sql<
      Row<typeof userPreferences, "default_setup_buffer_minutes" | "default_transition_buffer_minutes">[]
    >`SELECT default_setup_buffer_minutes,default_transition_buffer_minutes FROM user_preferences WHERE user_id=${userId}`;
    const locations = await this.sql<
      LocationRow[]
    >`SELECT * FROM condition_definitions WHERE user_id=${userId} AND kind='location' AND status='active'`;
    const presetSteps = await this.sql<
      any[]
    >`SELECT s.* FROM routine_preset_steps s JOIN routine_presets p ON p.id=s.preset_id WHERE p.user_id=${userId} AND p.status='active' ORDER BY s.preset_id,s.sequence`;
    const presetDependencies = await this.sql<
      any[]
    >`SELECT d.step_id,d.depends_on_step_id FROM routine_preset_step_dependencies d JOIN routine_preset_steps s ON s.id=d.step_id JOIN routine_presets p ON p.id=s.preset_id WHERE p.user_id=${userId}`;
    const calendarIds = args.calendars.map((calendar) => calendar.calendarId);
    const links = calendarIds.length
      ? await this.sql<CalendarLinkRow[]>`
          SELECT l.*, fc.title, fc.starts_at, fc.ends_at, fc.status, fc.location, fc.setup_before_minutes, fc.transition_after_minutes, fc.version
          FROM calendar_event_links l JOIN commitments fc ON fc.id=l.commitment_id
          WHERE l.user_id=${userId} AND l.provider='google_calendar' AND l.frame_id IN ${this.sql(calendarIds)}
        `
      : [];
    const importedSeriesKeys = new Set(
      (
        await this.sql<
          Row<typeof importEntityKeys, "import_key">[]
        >`SELECT import_key FROM import_entity_keys WHERE user_id=${userId} AND entity_type='fixed_commitment_recurrence'`
      ).map((row) => row.import_key)
    );
    const dismissals = await this.sql<
      CalendarDismissalRow[]
    >`SELECT external_event_id,title,starts_at FROM calendar_event_dismissals WHERE user_id=${userId} AND provider='google_calendar'`;
    const calendarNames = Object.fromEntries(args.calendars.map((calendar) => [calendar.calendarId, calendar.summary]));
    // What cross-source matching needs: the window's commitments (padded a day either side) and the
    // linked commitments' other links.
    const matchContext = await loadMatchContext(this.sql, {
      userId,
      fromIso: new Date(Date.parse(args.timeMin) - 86_400_000).toISOString(),
      toIso: new Date(Date.parse(args.timeMax) + 86_400_000).toISOString(),
      timezone: args.timezone
    });
    const commitmentLinks = await loadCommitmentLinks(this.sql, {
      userId,
      commitmentIds: links.map((row) => row.commitment_id)
    });
    const records = calendarDiffRecords(
      {
        matchContext,
        commitmentLinks,
        timezone: args.timezone,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        events: args.events,
        calendarNames,
        links,
        importedSeriesKeys,
        dismissals,
        locations,
        presetSteps,
        presetDependencies,
        defaults: defaults[0]
      },
      profileFor("google_calendar")
    );
    return {
      records,
      previewFor: (subset) => ({
        sourceType: "google_calendar",
        inputKind: "calendar_updates",
        timezone: args.timezone,
        templateVersion: "1",
        records: subset.map((record, index) => ({ ...record, sortOrder: index })),
        source: { text: googleCalendarSourceText({ events: args.events, calendarNames, records: subset }) }
      })
    };
  }

  /** A manual Google Calendar preview: everything the diff found, in one ordinary Inbox batch. */
  async previewGoogleCalendar(
    args: Parameters<PostgresImportStore["diffGoogleCalendar"]>[0]
  ): Promise<ImportBatch | null> {
    const { records, previewFor } = await this.diffGoogleCalendar(args);
    return records.length ? this.preview(previewFor(records)) : null;
  }

  /**
   * Which of these commitments something other than `ownProvider` also feeds: a calendar link from
   * another provider, or a source that is not this provider's own. A primary source is the only definitive one and
   * every other source is secondary, so a change arriving from one secondary source to a commitment a
   * second source also feeds is a disagreement the owner decides, never one the sync applies on its own.
   * Written against the links table (not "one link per commitment") so it holds once a commitment may
   * carry a link from each provider.
   */
  async commitmentsFedByOtherSources(
    commitmentIds: string[],
    ownProvider: string,
    ownSourceType: string
  ): Promise<Set<string>> {
    if (!commitmentIds.length) return new Set();
    const userId = await ensureUser(this.sql);
    const rows = await this.sql<{ id: string }[]>`
      SELECT commitment_id AS id FROM calendar_event_links
      WHERE user_id=${userId} AND commitment_id IN ${this.sql(commitmentIds)} AND provider <> ${ownProvider}
      UNION
      SELECT fc.id FROM commitments fc JOIN sources s ON s.id=fc.source_id
      WHERE fc.user_id=${userId} AND fc.id IN ${this.sql(commitmentIds)} AND s.source_type <> ${ownSourceType}
    `;
    return new Set(rows.map((row) => row.id));
  }

  /** The open (draft, ready or blocked) batches of one source type, with the source text they were built from. */
  async openBatches(
    sourceType: ImportBatch["sourceType"]
  ): Promise<{ id: string; version: number; sourceText: string | null }[]> {
    const userId = await ensureUser(this.sql);
    const rows = await this.sql<Row<typeof importBatches, "id" | "version" | "source_text">[]>`
      SELECT id, version, source_text FROM import_batches
      WHERE user_id=${userId} AND source_type=${sourceType} AND status IN ${this.sql(OPEN_IMPORT_BATCH_STATUSES)}
      ORDER BY created_at DESC
    `;
    return rows.map((row) => ({ id: row.id, version: row.version, sourceText: row.source_text }));
  }

  async get(id: string): Promise<ImportBatch | null> {
    const userId = await ensureUser(this.sql);
    const batches = await this.sql<any[]>`SELECT * FROM import_batches WHERE id=${id} AND user_id=${userId}`;
    if (!batches[0]) return null;
    const records = await this.sql<any[]>`SELECT * FROM import_records WHERE batch_id=${id} ORDER BY sort_order, id`;
    const mapped = mapBatch(batches[0], records);
    return importBatchSchema.parse(mapped);
  }

  /**
   * Removes a queued batch outright. `import_records` is declared `ON DELETE cascade` from
   * `import_batches`, and nothing else in the schema points at a batch, so the one DELETE is the
   * whole removal.
   *
   * A committed batch is refused rather than deleted: it is the record of what an import actually
   * did to the plan, and `import_entity_keys` still maps its keys onto live entities. The queue only
   * ever lists open batches, so this only fires on a stale identifier.
   *
   * No `write_rows` row is written. That table is how the planner decides its forecast has gone
   * stale, and a draft that was never committed changed nothing it could be stale against —
   * recording this would invalidate a perfectly good forecast for a batch the plan never saw.
   *
   * Returns false when no batch matched, which the route answers as a 404.
   */
  async delete(id: string, options?: { recordDismissals?: boolean }): Promise<boolean> {
    const userId = await ensureUser(this.sql);
    let deleted = false;
    await this.sql.begin(async (tx) => {
      const rows = await tx<
        { status: string; source_type: string; source_text: string | null }[]
      >`SELECT status, source_type, source_text FROM import_batches WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      if (!rows[0]) return;
      if (rows[0].status === "committed")
        throw new ImportConflictError("A committed batch is a record of what was imported and cannot be deleted.");
      // A person discarding a Google Calendar batch has declined every event proposed in it, so none of
      // them comes back on the next run (until it changes). The sync's own superseding deletes never
      // pass this option: replacing a stale review batch is not a decision about its events.
      const dismissalProvider = rows[0].source_type;
      // A source that keeps no dismissals (the roster: it is definitive) has nothing to record.
      const profileDismissals = findProfile(dismissalProvider)?.dismissals;
      if (options?.recordDismissals && profileDismissals && rows[0].source_text) {
        const records = (
          await tx<
            {
              import_key: string;
              operation: string;
              removed: boolean;
              entity_type: string;
              matched_entity_id: string | null;
              relationships: Record<string, string>;
              fields: ImportRecord["fields"];
            }[]
          >`SELECT import_key, operation, removed, entity_type, matched_entity_id, relationships, fields FROM import_records WHERE batch_id=${id}`
        ).map((row) => ({
          importKey: row.import_key,
          operation: row.operation as ImportRecord["operation"],
          removed: row.removed,
          entityType: row.entity_type as ImportRecord["entityType"],
          matchedEntityId: row.matched_entity_id,
          relationships: row.relationships ?? {},
          fields: row.fields ?? {}
        }));
        await releaseKeptCalendarLinks(tx, userId, dismissalProvider, records, "all");
        await recordCalendarDismissals(
          tx,
          userId,
          dismissalProvider,
          declinedDeleteDismissals(records, `${dismissalProvider}:event:`, "all")
        );
        const source = JSON.parse(rows[0].source_text);
        await recordCalendarDismissals(
          tx,
          userId,
          dismissalProvider,
          profileDismissals.inserts(records, source, "all")
        );
      }
      await tx`DELETE FROM import_batches WHERE id=${id}`;
      deleted = true;
    });
    return deleted;
  }

  /**
   * Deletes every other open (draft/ready/blocked) batch of one source type, keeping `keepBatchId`.
   * The roster provider sync calls this right after its own run leaves a fresh held-for-review batch behind, so a
   * stale review batch from an earlier run never sits in the Inbox alongside the new one — without
   * this, every scheduled run that still finds a conflict would add another copy of it. Never touches
   * a committed batch (`delete` refuses those). A run that holds nothing back does not call this: it
   * deletes the open batches itself (as `calendar-sync.ts` does), because they are stale by then.
   *
   * `options.sourceTextContains` narrows this to the batches whose `source_text` holds that text: unlike the roster provider
   * roster (one source, one open batch at a time), a source with several owners can have a held batch open for
   * each, and a superseding run for one must never touch another's. `source_text` carries the owner's id so
   * this can filter on it without a schema change to `import_batches`.
   */
  async supersedeOpenBatches(
    sourceType: ImportBatch["sourceType"],
    keepBatchId: string,
    options?: { sourceTextContains?: string }
  ): Promise<number> {
    const userId = await ensureUser(this.sql);
    const rows = options?.sourceTextContains
      ? await this.sql<{ id: string }[]>`
          SELECT id FROM import_batches
          WHERE user_id=${userId} AND source_type=${sourceType} AND id != ${keepBatchId}
            AND status IN ${this.sql(OPEN_IMPORT_BATCH_STATUSES)}
            AND source_text LIKE ${`%${options.sourceTextContains}%`}
        `
      : await this.sql<{ id: string }[]>`
          SELECT id FROM import_batches
          WHERE user_id=${userId} AND source_type=${sourceType} AND id != ${keepBatchId}
            AND status IN ${this.sql(OPEN_IMPORT_BATCH_STATUSES)}
        `;
    let deleted = 0;
    for (const row of rows) if (await this.delete(row.id)) deleted += 1;
    return deleted;
  }

  /**
   * Gives every reference-pack candidate a stable import key, minting one for any entity that has
   * none yet, and returns the map. Minting is one INSERT for all the new keys; ON CONFLICT keeps a
   * key that arrived from elsewhere in the meantime.
   */
  async ensureReferenceKeys(candidates: ReferenceKeyCandidate[]): Promise<ReferenceKeyMap> {
    const userId = await ensureUser(this.sql);
    const unique = [
      ...new Map(candidates.map((candidate) => [`${candidate.entityType}:${candidate.entityId}`, candidate])).values()
    ];
    await this.sql.begin(async (tx) => {
      const existing = await tx<
        Row<typeof importEntityKeys, "entity_type" | "entity_id">[]
      >`SELECT entity_type, entity_id FROM import_entity_keys WHERE user_id=${userId}`;
      const mapped = new Set(existing.map((row) => `${row.entity_type}:${row.entity_id}`));
      const missing = unique.filter((candidate) => !mapped.has(`${candidate.entityType}:${candidate.entityId}`));
      if (!missing.length) return;
      const rows = missing.map((candidate) => ({
        user_id: userId,
        entity_type: candidate.entityType,
        import_key: fallbackReferenceKey(candidate),
        entity_id: candidate.entityId
      }));
      await tx`INSERT INTO import_entity_keys ${tx(rows)} ON CONFLICT DO NOTHING`;
    });
    const rows = await this.sql<
      // `entity_type` narrowed from `text`: keys are written only for reference-pack entity types.
      (Row<typeof importEntityKeys, "entity_type" | "entity_id" | "import_key"> & {
        entity_type: ReferenceKeyCandidate["entityType"];
      })[]
    >`
      SELECT entity_type, entity_id, import_key FROM import_entity_keys WHERE user_id=${userId}
      ORDER BY created_at DESC, import_key DESC
    `;
    // A commitment with several sources holds several keys; the rows arrive newest first, so the oldest
    // (the source that created it) is the one left standing.
    const requested = new Set(unique.map((candidate) => `${candidate.entityType}:${candidate.entityId}`));
    const result: ReferenceKeyMap = {};
    for (const row of rows) {
      if (!requested.has(`${row.entity_type}:${row.entity_id}`)) continue;
      result[row.entity_type] ??= {};
      result[row.entity_type]![row.entity_id] = row.import_key;
    }
    if (Object.values(result).reduce((sum, entries) => sum + Object.keys(entries ?? {}).length, 0) !== unique.length)
      throw new Error("Could not assign stable import keys to every reference record.");
    return result;
  }

  async update(id: string, expectedVersion: number, inputRecords: ImportRecord[]): Promise<ImportBatch> {
    const userId = await ensureUser(this.sql);
    await this.sql.begin(async (tx) => {
      const rows = await tx<
        Row<typeof importBatches, "version" | "status">[]
      >`SELECT version, status FROM import_batches WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      if (!rows[0]) throw new Error(refusalText(notFoundRefusal("import batch", id)));
      if (rows[0].status === "committed")
        throw new ImportConflictError(
          `Import batch "${id}" is already committed, so it cannot be edited. Start a new import for further changes.`
        );
      if (rows[0].version !== expectedVersion)
        throw new ImportConflictError("This import draft changed elsewhere. Read it again before saving.");
      const records = await resolveOperations(tx, userId, inputRecords);
      await tx`DELETE FROM import_records WHERE batch_id=${id}`;
      await writeRecords(tx, id, records);
      await tx`UPDATE import_batches SET status=${batchStatus(records)}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
    });
    return (await this.get(id))!;
  }

  async commit(id: string, expectedVersion: number): Promise<ImportBatch> {
    return (await this.commitBatch(id, expectedVersion, "all")).batch;
  }

  /**
   * Commits only the records with no blockers and moves the blocked ones, in the same transaction,
   * into a new draft batch — same source, timezone and content hash, filename suffixed "(blocked
   * rows)" — so the clean rows land now and the rest wait in the queue to be fixed. A ready record
   * that points at a blocked one (an action whose project is blocked) moves with it: it could not be
   * written without its target and would otherwise fail the whole commit. Nothing is written when no
   * record is ready. `deferred` is null when there were no blockers and this was a plain commit.
   */
  async commitReady(
    id: string,
    expectedVersion: number
  ): Promise<{
    batch: ImportBatch;
    deferred: ImportBatch | null;
    extensionOutcomes: Record<string, unknown>;
  }> {
    return this.commitBatch(id, expectedVersion, "ready");
  }

  private async commitBatch(
    id: string,
    expectedVersion: number,
    mode: "all" | "ready"
  ): Promise<{
    batch: ImportBatch;
    deferred: ImportBatch | null;
    extensionOutcomes: Record<string, unknown>;
  }> {
    const userId = await ensureUser(this.sql);
    let deferredId: string | null = null;
    const extensionOutcomes: Record<string, unknown> = {};
    await this.sql.begin(async (tx) => {
      const batchRows = await tx<
        {
          version: number;
          status: string;
          source_type: ImportBatch["sourceType"];
          input_kind: ImportBatch["inputKind"];
          timezone: string;
          source_text: string | null;
          source_filename: string | null;
          source_mime_type: string | null;
          content_hash: string | null;
          source_files: unknown;
        }[]
      >`SELECT version, status, source_type, input_kind, timezone, source_text, source_filename, source_mime_type, content_hash, source_files FROM import_batches WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      const batch = batchRows[0];
      if (!batch) throw new Error(refusalText(notFoundRefusal("import batch", id)));
      if (batch.status === "committed")
        throw new ImportConflictError(`Import batch "${id}" is already committed, so it cannot be committed again.`);
      if (batch.version !== expectedVersion)
        throw new ImportConflictError("This import draft changed elsewhere. Read it again before committing.");
      const raw = await tx<any[]>`SELECT * FROM import_records WHERE batch_id=${id} ORDER BY sort_order, id`;
      const records = await resolveOperations(tx, userId, raw.map(mapRecord));
      const isBlocker = (record: ImportRecord) =>
        !record.removed &&
        (record.errors.length > 0 || record.operation === "conflict" || record.operation === "rejected");
      const blockers = records.filter(isBlocker);
      if (mode === "all" && blockers.length)
        throw new Error(`Import has ${blockers.length} blocking record(s). Fix or remove them before committing.`);
      const mappedKeys = new Set(
        (
          await tx<
            { entity_type: string; import_key: string }[]
          >`SELECT entity_type, import_key FROM import_entity_keys WHERE user_id=${userId}`
        ).map((row) => `${row.entity_type}:${row.import_key}`)
      );
      // A blocked half of a moved meeting takes its partner with it (never a lone half: `splitFeedMovePair` below).
      const deferred = deferPairPartners(records, deferWithBlockedTargets(records, blockers, mappedKeys));
      const deferredIds = new Set(deferred.map((record) => record.id));
      const ready = records.filter((record) => !record.removed && !deferredIds.has(record.id));
      const split = splitFeedMovePair(records, (record) => !record.removed && !deferredIds.has(record.id));
      if (split) throw new ImportConflictError(split);
      if (mode === "ready" && !ready.length)
        throw new Error("No records are ready to commit. Fix at least one blocker first.");
      if (requestAgent() !== null) {
        const floor = await agentImportFloor(tx, userId, ready);
        if (floor !== null) throw new ForbiddenCommandError(`An agent token cannot make this write: ${floor}.`);
      }
      // The hourly close brake covers the commitments this commit cancels (a token agent only; no proposal path exists
      // for an import, so the refusal says to wait or ask the owner to commit it).
      const closing = requestAgent() !== null ? closingRecordCount(ready) : 0;
      if (closing > 0) {
        await lockCloseBudget(tx, userId);
        try {
          await assertCloseBudget(tx, userId, closing, {
            nextCall: {
              tool: "rhen_status",
              arguments: {},
              note: "the owner commits this batch in Inbox > Calendar & imports"
            }
          });
        } catch (error) {
          if (error instanceof CommandConflictError)
            throw new ForbiddenCommandError(
              `An agent token cannot make this write: ${error.message.replace(/ Repeat the call and it is filed as a proposal for the owner to confirm\./, "")} The owner commits this batch in Inbox > Calendar & imports.`
            );
          throw error;
        }
      }
      const linkSource: GoogleCalendarSource | ExtensionLinkSource | undefined =
        batch.source_text &&
        (isExtensionSourceType(batch.source_type) ||
          calendarSourceConnections().some((connection) => connection.id === batch.source_type))
          ? JSON.parse(batch.source_text)
          : undefined;
      await commitRecords(tx, userId, ready, linkSource);
      // The ledger row the brake counts the next call from; counted only when a token agent made it.
      if (closing > 0)
        await recordStateChange(tx, userId, {
          entityType: "fixed_commitment",
          operation: "close",
          evidence: { closed: closing, via: "import", batch: id, counted: closeBudgetApplies() },
          at: new Date()
        });
      // An event left unselected when a calendar batch is committed was rejected: remember it so the next
      // automatic run does not propose it again (until its title or start changes).
      const profileDismissals = linkSource ? findProfile(linkSource.provider)?.dismissals : undefined;
      if (linkSource && profileDismissals && "events" in linkSource) {
        await releaseKeptCalendarLinks(tx, userId, linkSource.provider, records, "deselected");
        await recordCalendarDismissals(
          tx,
          userId,
          linkSource.provider,
          declinedDeleteDismissals(records, `${linkSource.provider}:event:`, "deselected")
        );
        await recordCalendarDismissals(
          tx,
          userId,
          linkSource.provider,
          profileDismissals.inserts(records, linkSource, "deselected")
        );
      }
      // This batch is marked committed before the deferred follow-up batch (below) is inserted: the
      // follow-up deliberately keeps the same source and content hash, and `import_batches_open_content_unique`
      // (schema.ts) only excludes committed rows from that hash — inserting the follow-up while this
      // row still showed an open status would collide with its own predecessor under that index.
      await tx`UPDATE import_batches SET status='committed', committed_at=CURRENT_TIMESTAMP, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
      if (deferred.length) {
        // The blocked rows leave this batch — a committed batch is the record of exactly what it wrote
        // — and become a new draft through the same path every batch takes, keeping their ids, their
        // fields' provenance and the upload's hash, so a re-upload of the same file finds them.
        await tx`DELETE FROM import_records WHERE batch_id=${id} AND id IN ${tx([...deferredIds])}`;
        const source = batchSource(batch);
        deferredId = await insertBatch(
          tx,
          userId,
          {
            sourceType: batch.source_type,
            inputKind: batch.input_kind,
            timezone: batch.timezone,
            templateVersion: "1",
            records: deferred,
            source: { ...source, filename: source.filename ? `${source.filename} (blocked rows)` : "(blocked rows)" }
          },
          deferred
        );
      }
      for (const extension of importExtensions()) {
        if (!linkSource || !extension.sourceTypes.includes(linkSource.provider) || !extension.afterCommit) continue;
        extensionOutcomes[extension.id] = await extension.afterCommit(tx, {
          userId,
          linkSource,
          records,
          ready,
          deferred,
          committedBatchId: id,
          deferredBatchId: deferredId
        });
      }
      // The receipt id is the batch's own id, and what a commit writes is that stored batch (its status and version
      // guard a second commit), not a payload a caller sent under a reusable id: no different write can arrive under
      // it, so there is nothing to hash.
      await claimCommandReceipt(tx, { id, userId, commandType: "import_commit" });
      await recordStateChange(tx, userId, {
        entityType: "import_batch",
        entityId: id,
        operation: "commit",
        commandId: id,
        at: new Date()
      });
    });
    return {
      batch: (await this.get(id))!,
      deferred: deferredId ? await this.get(deferredId) : null,
      extensionOutcomes
    };
  }
}

// Methods a provider's private extension adds to the store (the roster provider and the calendar provider diffs): see `imports/store-methods.ts`.
installStoreMethods(PostgresImportStore.prototype);

export async function withImportStore<T>(operation: (store: PostgresImportStore) => Promise<T>): Promise<T> {
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error("Import Centre requires PostgreSQL.");
  return operation(new PostgresImportStore(sqlPool(connectionString)));
}
