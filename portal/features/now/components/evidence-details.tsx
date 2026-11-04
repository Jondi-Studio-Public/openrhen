"use client";

import type { ReactNode } from "react";

/**
 * The collapsed "why" list every Now panel shows under its own wording. The summary differs per
 * panel; the evidence list and its markup do not, so they are stated once.
 */
export function EvidenceDetails({
  summary,
  evidence,
  children
}: {
  summary: string;
  evidence: readonly string[];
  children?: ReactNode;
}) {
  return (
    <details className="calculation-details">
      <summary>{summary}</summary>
      <ul>
        {evidence.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      {children}
    </details>
  );
}
