"use client";

import { Field } from "@/components/field";
import { MinuteInput, PercentInput, Section } from "@/features/settings/components/settings-fields";
import type { PlanningSettings } from "@/state/portal-state";

export function BuffersSection({
  draft,
  onChange
}: {
  draft: PlanningSettings;
  onChange: (patch: Partial<PlanningSettings>) => void;
}) {
  return (
    <Section id="buffers" title="Buffers" reason="Protected time the system avoids promising elsewhere.">
      <Field label="Default setup before (minutes)">
        <MinuteInput
          value={draft.defaultSetupBufferMinutes}
          onChange={(value) => onChange({ defaultSetupBufferMinutes: value })}
        />
      </Field>
      <Field label="Default transition after (minutes)">
        <MinuteInput
          value={draft.defaultTransitionBufferMinutes}
          onChange={(value) => onChange({ defaultTransitionBufferMinutes: value })}
        />
      </Field>
      <Field label="Minimum submission buffer (minutes)">
        <MinuteInput
          value={draft.submissionBufferMinutes}
          onChange={(value) => onChange({ submissionBufferMinutes: value })}
        />
      </Field>
      <Field label="Submission buffer percentage">
        <PercentInput
          value={draft.submissionBufferPercent}
          onChange={(value) => onChange({ submissionBufferPercent: value })}
        />
      </Field>
      <Field label="Arrival margin (minutes)">
        <input
          type="number"
          min="0"
          step="1"
          value={draft.arrivalMarginMinutes}
          onChange={(event) => onChange({ arrivalMarginMinutes: Number(event.target.value) })}
        />
        <small>
          Added on top of travel time before a commitment that involves a journey — a couple of minutes to actually
          arrive and settle in, not just pull up outside. Has no effect on a commitment with no travel leg.
        </small>
      </Field>
      <Field label="Default mode">
        <select
          value={draft.defaultTransportMode ?? ""}
          onChange={(event) =>
            onChange({
              defaultTransportMode: (event.target.value || undefined) as PlanningSettings["defaultTransportMode"]
            })
          }
        >
          <option value="">No opinion — falls to the fastest available</option>
          <option value="car">Car</option>
          <option value="bike">Bike</option>
          <option value="walk">Walk</option>
        </select>
        <small>How a leg is reached when neither the commitment nor the place says.</small>
      </Field>
      <Field label="Start-by warning lead (minutes)">
        <input
          type="number"
          min="0"
          step="1"
          value={draft.startByWarningMinutes}
          onChange={(event) => onChange({ startByWarningMinutes: Number(event.target.value) })}
        />
        <small>
          How far ahead of a step's latest start to warn that it is coming due. Only steps with a must-start-by or a
          wait get a start-by warning at all.
        </small>
      </Field>
      <Field label="Break after a maximum session (minutes)">
        <input
          type="number"
          min="0"
          step="1"
          value={draft.sessionBreakMinutes}
          onChange={(event) => onChange({ sessionBreakMinutes: Number(event.target.value) })}
        />
        <small>
          The gap the forecast owes after a session reaches its maximum length: the same action won't be reserved again
          until this many minutes have passed, though other work may use the gap.
        </small>
      </Field>
    </Section>
  );
}
