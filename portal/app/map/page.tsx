"use client";

import { PlanMapPage } from "@/features/plan-map/components/plan-map-page";

/**
 * `/map`: the read-only plan map. `?item=<type>:<id>` names the centre; without it the map opens on the
 * busiest area and offers the subjects and projects to start from. Everything is drawn in the browser
 * from portal state and the stored links, in `features/plan-map/components/plan-map-page.tsx`.
 */
export default function MapPage() {
  return (
    <main className="content-page">
      <PlanMapPage />
    </main>
  );
}
