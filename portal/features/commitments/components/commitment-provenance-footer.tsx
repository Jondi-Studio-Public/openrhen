"use client";

import { connectionManifest } from "@openrhen/contracts";
import type { StoredCommitment } from "@/state/portal-state";
import { formatZonedDateTime } from "@/shared/date-format";
import { extensionProvenanceLabel as extensionProvenanceLead } from "@/state/extensions";
import { useRecordWriters } from "../use-record-writers";

/** How an imported source type reads in a sentence, without inventing a name for an unknown one. */
function sourceLabel(sourceType: string, title: string | undefined): string {
  const manifest = connectionManifest(sourceType);
  // A shared calendar the plan also publishes to reads as "the X calendar", a primary roster source as "the X roster".
  if (manifest?.capabilities.includes("calendar_sink"))
    return `the ${manifest.label} calendar${title ? ` · “${title}”` : ""}`;
  if (manifest?.calendarSource?.role === "primary")
    return `the ${manifest.label} roster${title ? ` · “${title}”` : ""}`;
  if (sourceType === "import") return `a bulk import${title ? ` · “${title}”` : ""}`;
  const named = title ? `“${title}”` : "";
  return named ? `${sourceType} · ${named}` : sourceType;
}

/**
 * Where the record came from and when it last moved. A commitment that arrived by import is not the
 * same thing as one someone typed: the next import can change it under you, and this is the only
 * place that says so. Likewise one an agent wrote: the write ledger names the agent, so it never reads
 * "Entered by hand", and an agent's latest change is named next to when it happened.
 */
export function CommitmentProvenanceFooter({
  commitment,
  timezone
}: {
  commitment: StoredCommitment;
  timezone: string;
}) {
  const when = (value: string | undefined) => (value ? formatZonedDateTime(value, timezone) : "an unrecorded time");
  const { createdBy, lastChangedBy } = useRecordWriters(commitment.id, "commitments", commitment.version);
  return (
    <footer className="commitment-provenance">
      <p className="microcopy">
        {commitment.sourceType && extensionProvenanceLead(commitment.sourceType, commitment.sourceTitle) ? (
          <>
            {extensionProvenanceLead(commitment.sourceType, commitment.sourceTitle)}.{" "}
            <a href="/inbox/calendar">See the import history</a>.
          </>
        ) : commitment.sourceType ? (
          <>
            Imported from {sourceLabel(commitment.sourceType, commitment.sourceTitle)}.{" "}
            <a href="/inbox/calendar">See the import history</a>.
          </>
        ) : createdBy && createdBy !== "person" ? (
          <>
            Added by the agent {createdBy.agent}; no import owns this record.{" "}
            <a href="/review#agent-changes">See agent changes</a>.
          </>
        ) : createdBy === "person" ? (
          "Entered by hand; no import owns this record."
        ) : (
          // The ledger cannot say who made it (made before it kept row images): say only what is known.
          "No import owns this record."
        )}
      </p>
      <p className="microcopy">
        Created {when(commitment.createdAt)} · last changed {when(commitment.updatedAt)}
        {lastChangedBy ? ` by the agent ${lastChangedBy}` : ""}.
      </p>
    </footer>
  );
}
