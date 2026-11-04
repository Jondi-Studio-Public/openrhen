"use client";

import { useState } from "react";
import { CALIBRATION_MIN_SAMPLES, type CalibrationFactor } from "@openrhen/contracts/readiness";
import { Field } from "@/components/field";
import { Section } from "@/features/settings/components/settings-fields";
import { createClientId } from "@/shared/client-id";
import { isVersionConflictError } from "@/shared/use-server-draft";
import { usePortal } from "@/state/portal-provider";

/**
 * Settings → Planning → Estimates, "Learned calibration" (logic design §5): the switch and a
 * read-only view of the factors the server derived from finished work. Nothing here is edited; the
 * factors are recomputed from session history on every read.
 */

function describe(label: string, entry: CalibrationFactor, timeZone: string): string {
  const noun = entry.samples === 1 ? "finished action" : "finished actions";
  const last = new Date(entry.lastSampleAt).toLocaleDateString(undefined, {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric"
  });
  return `${label}: ×${entry.factor.toFixed(2)} from ${entry.samples} ${noun}, last on ${last}`;
}

export function EstimateCalibrationSection() {
  const { state, saving, saveEntityCommand } = usePortal();
  const [error, setError] = useState("");
  const enabled = state.settings.estimateCalibrationEnabled;
  const calibration = state.estimateCalibration;
  const areaNames = new Map(state.areas.map((area) => [area.id, area.name]));
  const areaLines = calibration.areas.flatMap((entry) => {
    const name = areaNames.get(entry.areaId);
    return name ? [{ id: entry.areaId, text: describe(name, entry, state.settings.timezone) }] : [];
  });

  async function toggle(next: boolean) {
    setError("");
    try {
      await saveEntityCommand({
        commandId: createClientId(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "settings",
        entity: { estimateCalibrationEnabled: next }
      });
    } catch (reason) {
      setError(
        isVersionConflictError(reason)
          ? "These settings changed on another device. Reload and try again."
          : "Could not save the calibration setting."
      );
    }
  }

  return (
    <Section
      id="learned-calibration"
      title="Learned calibration"
      reason="A factor above 1 means work took longer than estimated; planning scales estimates by it. Areas with fewer than 5 finished actions use the all-areas factor."
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Field label="Adjust estimates" wide>
        <span className="checkbox-row">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(event) => void toggle(event.target.checked)}
          />{" "}
          Adjust estimates from finished work
        </span>
      </Field>
      {calibration.overall ? (
        <Field label="Learned factors" wide group>
          <ul className="microcopy">
            <li>{describe("All areas", calibration.overall, state.settings.timezone)}</li>
            {areaLines.map((line) => (
              <li key={line.id}>{line.text}</li>
            ))}
          </ul>
        </Field>
      ) : (
        <p className="microcopy">
          Not enough history yet. Estimates start adjusting after {CALIBRATION_MIN_SAMPLES} finished actions timed with
          sessions.
        </p>
      )}
    </Section>
  );
}
