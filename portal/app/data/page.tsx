"use client";

import { DataFlowPage } from "@/features/data-flow/components/data-flow-page";

/**
 * `/data`: the live data map. Every collector, store, reader and value surface from the code's registry, coloured by
 * live health. Read-only; the graph is `GET /api/data-flow`, and the page polls it every minute while visible.
 */
export default function DataRoute() {
  return (
    <main className="content-page">
      <DataFlowPage />
    </main>
  );
}
