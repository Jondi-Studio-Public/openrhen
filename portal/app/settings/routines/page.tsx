"use client";

import { RoutineEditorSection } from "@/features/routines/components/routine-editor-section";
import { TimeBandsSection } from "@/features/settings/components/time-bands-section";
import { SettingsHead } from "@/features/settings/components/settings-head";

/**
 * Routines is a Settings section; this route keeps its own address (the rail links here) and renders
 * the same editor on its own page, plus the time bands
 * a flexible before-step can prefer.
 */
export default function RoutinesPage() {
  return (
    <main className="content-page routine-page">
      <RoutineEditorSection
        heading={
          <SettingsHead
            href="/settings/routines"
            answer="The steps that get you ready; an arrow means one step finishes before the next."
          />
        }
      />
      <TimeBandsSection />
    </main>
  );
}
