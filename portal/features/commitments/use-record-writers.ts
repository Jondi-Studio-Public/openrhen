"use client";

import { useEffect, useState } from "react";

/**
 * Who wrote a record, from the write ledger. `createdBy` is the agent that made it, `"person"` when the
 * ledger shows the person did, or null when the ledger cannot say (made before the ledger kept row images,
 * or by an import). `lastChangedBy` names an agent only when its write left the record at its current version.
 */
export interface RecordWriters {
  createdBy: { agent: string } | "person" | null;
  lastChangedBy: string | null;
}

/** One `GET /api/changes?entityId=&images=1` row: the write's actor and what its row image says about the record. */
interface FeedRow {
  actor: string | null;
  /** The table the write's image of this record is from; null when the write kept no image. */
  imageTable?: string | null;
  /** The image has no before row: this write inserted the record. */
  inserted?: boolean;
  /** The record's version as this write left it. */
  afterVersion?: number | null;
}

const NONE: RecordWriters = { createdBy: null, lastChangedBy: null };

/** `actor` is null for the person and `system` for background writers; anything else names an agent. */
const agentOf = (actor: string | null) => (actor && actor !== "system" ? actor : null);

/**
 * Reads the writers from a record's ledger rows, newest first (agent trust review, lane D item 7: a record an
 * agent wrote must not read "Entered by hand"). The creating write is the one whose image inserted a row into
 * `table`, not the oldest row for the id: a confirmed capture keeps the capture's id, so its oldest row is the
 * capture. With no such image, a record no agent ever wrote is the person's; one an agent wrote stays unknown.
 * The last writer is the one whose image left the record at `version`; a bulk touch of `updated_at`
 * or an import (which writes under an `import_batch` row) leaves no such row, so no one is named.
 */
export function writersFrom(rows: readonly FeedRow[], table: string, version: number | undefined): RecordWriters {
  const insert = [...rows].reverse().find((row) => row.imageTable === table && row.inserted === true);
  // No insert image, but no agent ever wrote the record either: the person made it.
  const createdBy = insert
    ? agentOf(insert.actor)
      ? { agent: agentOf(insert.actor)! }
      : "person"
    : rows.some((row) => agentOf(row.actor))
      ? null
      : "person";
  const latest =
    version === undefined ? undefined : rows.find((row) => row.imageTable === table && row.afterVersion === version);
  return { createdBy, lastChangedBy: latest ? agentOf(latest.actor) : null };
}

const PAGE = 200;

/** Who wrote record `id` in `table`; unknown until the ledger answers, and when it cannot be read. */
export function useRecordWriters(id: string, table: string, version: number | undefined): RecordWriters {
  // Keyed by the record, so another record's answer never shows while this one's is in flight.
  const [answer, setAnswer] = useState<{ key: string; writers: RecordWriters } | null>(null);
  const key = `${id}@${version ?? ""}`;
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/changes?entityId=${encodeURIComponent(id)}&limit=${PAGE}&images=1`, { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<{ changes?: unknown }>) : null))
      .then((body) => {
        if (!cancelled && Array.isArray(body?.changes))
          setAnswer({ key, writers: writersFrom(body.changes as FeedRow[], table, version) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, key, table, version]);
  return answer?.key === key ? answer.writers : NONE;
}
