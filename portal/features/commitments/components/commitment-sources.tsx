"use client";

import { useState } from "react";
import { sourceLabel } from "@openrhen/contracts";
import type { StoredCommitment } from "@/state/portal-state";

type CommitmentSource = NonNullable<StoredCommitment["sources"]>[number];

export function sourceProviderLabel(provider: CommitmentSource["provider"]): string {
  return sourceLabel(provider);
}

/**
 * The calendar sources this commitment is one copy of.
 * With more than one, each secondary source offers **Not the same event**: the wrong match is undone
 * in one step, the source leaving as a commitment of its own. The primary source (today only the roster provider) has
 * no such button, and a commitment with a single source has nothing to split it from.
 */
export function CommitmentSources({
  commitment,
  onSplit
}: {
  commitment: StoredCommitment;
  /** Splits the source with this link id off the commitment; rejects with the sentence to show. */
  onSplit: (linkId: string) => Promise<void>;
}) {
  const sources = commitment.sources ?? [];
  const [error, setError] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  if (sources.length === 0) return null;
  const canSplit = sources.length > 1 && commitment.version !== undefined;

  async function split(linkId: string) {
    setError("");
    setWorking(linkId);
    try {
      await onSplit(linkId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That source was not split off.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <section className="commitment-section" aria-labelledby="commitment-sources-heading">
      <div className="section-heading">
        <h2 id="commitment-sources-heading">Sources</h2>
      </div>
      <ul className="commitment-sources">
        {sources.map((source) => (
          <li key={source.id}>
            {sourceProviderLabel(source.provider)}
            {source.role === "primary" && <span className="microcopy"> · primary</span>}
            {canSplit && source.role === "secondary" && (
              <>
                {" "}
                <button
                  type="button"
                  className="quiet small"
                  disabled={working !== null}
                  onClick={() => void split(source.id)}
                >
                  Not the same event
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
