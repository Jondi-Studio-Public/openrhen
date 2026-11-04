"use client";

import { useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { createClientId } from "@/shared/client-id";
import { usePortal } from "@/state/portal-provider";
import { THRESHOLDS, parseThreshold, type ThresholdKey } from "@/features/pulse/pulse-view";

/**
 * Settings → Pulse → When the plan loses track: the three numbers that
 * decide when an unanswered check-in turns "not sure" into "off plan". A blank box is the default, which is shown
 * beside it; saving a blank box sends `null`, which restores it.
 */
export function PulseThresholdsSection() {
  const { ready } = usePortal();
  // The boxes start from the stored values, which are not there until the state has loaded.
  return <ThresholdsForm key={ready ? "ready" : "loading"} />;
}

function ThresholdsForm() {
  const { state, saving, saveEntityCommand } = usePortal();
  const [text, setText] = useState<Record<ThresholdKey, string>>(() => ({
    pulseUnknownToOffMinutes: String(state.settings.pulseUnknownToOffMinutes ?? ""),
    pulseFurtherPrompts: String(state.settings.pulseFurtherPrompts ?? ""),
    pulseUnknownHardOffMinutes: String(state.settings.pulseUnknownHardOffMinutes ?? "")
  }));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const parsed = THRESHOLDS.map((spec) => ({ spec, value: parseThreshold(spec, text[spec.key]) }));
  const problems = parsed.filter((entry) => typeof entry.value === "string");
  const effective = (key: ThresholdKey) => {
    const entry = parsed.find((candidate) => candidate.spec.key === key)!;
    return typeof entry.value === "number" ? entry.value : entry.spec.fallback;
  };
  const crossed = effective("pulseUnknownHardOffMinutes") < effective("pulseUnknownToOffMinutes");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (problems.length > 0 || crossed) return;
    setError("");
    setSaved(false);
    try {
      await saveEntityCommand({
        commandId: createClientId(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "settings",
        entity: Object.fromEntries(parsed.map(({ spec, value }) => [spec.key, value as number | null]))
      });
      setSaved(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the thresholds.");
    }
  }

  return (
    <section className="more-group" id="pulse-thresholds">
      <div className="section-heading">
        <h2>When the plan loses track</h2>
      </div>
      <p className="reason">
        Miss a check-in and the plan is unsure what you are doing. Stay unreachable for long enough and it marks you off
        plan until you tell it where you are. Leave a box blank for the default.
      </p>
      <form className="editor-grid" onSubmit={onSubmit}>
        {THRESHOLDS.map((spec) => {
          const result = parsed.find((entry) => entry.spec.key === spec.key)!.value;
          return (
            <Field key={spec.key} label={spec.label}>
              <input
                type="text"
                inputMode="numeric"
                value={text[spec.key]}
                placeholder={String(spec.fallback)}
                aria-describedby={`${spec.key}-help`}
                onChange={(event) => {
                  setSaved(false);
                  setText({ ...text, [spec.key]: event.target.value });
                }}
              />
              <small id={`${spec.key}-help`}>
                Default {spec.fallback}
                {spec.unit === "minutes" ? " minutes" : ""}. {spec.help}
                {typeof result === "string" ? ` ${result}` : ""}
              </small>
            </Field>
          );
        })}
        {crossed && (
          <p className="form-error" role="alert">
            The cap cannot be shorter than the first number of minutes.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" disabled={saving || problems.length > 0 || crossed}>
            Save
          </button>
          {saved && <span role="status">Saved.</span>}
        </div>
      </form>
    </section>
  );
}
