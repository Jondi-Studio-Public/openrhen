"use client";

import { useState } from "react";
import { usePortal } from "@/state/portal-provider";
import { TypedConditionManager } from "@/features/settings/components/typed-context-manager";
import { createClientId } from "@/shared/client-id";
import { SettingsHead } from "@/features/settings/components/settings-head";

/**
 * Locations, capabilities, and contacts — the typed conditions the planner reads requirements and
 * preferences against. The home base saves the moment it is chosen, the same way each typed condition
 * saves the moment its own editor closes: nothing here waits on a page-wide Save.
 */
export default function ConditionsSettingsPage() {
  const { state, saving, saveEntityCommand } = usePortal();
  const [homeError, setHomeError] = useState("");

  async function saveHomeLocation(homeLocationId: string | undefined) {
    try {
      await saveEntityCommand({
        commandId: createClientId(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "settings",
        entity: { homeLocationId: homeLocationId ?? "" }
      });
      setHomeError("");
    } catch (error) {
      setHomeError(error instanceof Error ? error.message : "The home location was not saved.");
    }
  }

  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/catalogues/conditions"
        answer="Your places, capabilities and contacts, including where home is."
      />
      {homeError && (
        <p className="form-error" role="alert">
          {homeError}
        </p>
      )}
      <TypedConditionManager
        definitions={state.conditionDefinitions}
        actions={state.actions}
        routinePresets={state.routinePresets}
        commitmentRecurrenceRules={state.commitmentRecurrenceRules}
        commitments={state.commitments}
        saving={saving}
        homeLocationId={state.settings.homeLocationId}
        onHomeLocationChange={(homeLocationId) => void saveHomeLocation(homeLocationId)}
        onSave={(entity, expectedVersion) =>
          saveEntityCommand({
            commandId: createClientId(),
            expectedVersion,
            type: "save_entity",
            entityType: "condition_definition",
            entity
          })
        }
      />
    </main>
  );
}
