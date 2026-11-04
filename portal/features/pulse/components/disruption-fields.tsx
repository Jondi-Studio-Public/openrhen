"use client";

import { Chip } from "@/components/ui/chip";
import { placeOptions, type ConditionDefinition } from "@/features/settings/context-summary";
import { UNTIL_PRESETS, toggleDisruptionContext, type DisruptionDraft } from "../disruption-model";
import styles from "./reentry-panel.module.css";

/**
 * What the plan needs to keep a deviation on plan: until when, where,
 * what is available and whether it takes all of you. The words for what you are doing sit with the caller's own
 * fields. Controlled; the caller validates with `missingDisruption` and shows what is missing.
 */
export function DisruptionFields({
  draft,
  onChange,
  definitions
}: {
  draft: DisruptionDraft;
  onChange: (draft: DisruptionDraft) => void;
  definitions: ConditionDefinition[];
}) {
  const places = placeOptions(definitions);
  const contexts = definitions.filter((entry) => entry.kind !== "location" && entry.status === "active");
  return (
    <>
      <fieldset className={styles.group}>
        <legend className={styles.label}>Until roughly when?</legend>
        <div className={styles.chips}>
          {UNTIL_PRESETS.map((preset) => (
            <Chip
              key={preset.id}
              pressed={draft.untilChoice === preset.id}
              onClick={() => onChange({ ...draft, untilChoice: preset.id })}
            >
              {preset.label}
            </Chip>
          ))}
          <Chip pressed={draft.untilChoice === "custom"} onClick={() => onChange({ ...draft, untilChoice: "custom" })}>
            Pick a time
          </Chip>
        </div>
        {draft.untilChoice === "custom" && (
          <input
            type="datetime-local"
            aria-label="Until"
            value={draft.untilCustom}
            onChange={(event) => onChange({ ...draft, untilCustom: event.target.value })}
          />
        )}
      </fieldset>
      <fieldset className={styles.group}>
        <legend className={styles.label}>Where are you?</legend>
        <div className={styles.chips}>
          {places.map((place) => (
            <Chip
              key={place.id}
              pressed={draft.locationId === place.id}
              onClick={() => onChange({ ...draft, locationId: draft.locationId === place.id ? "" : place.id })}
            >
              {place.name}
            </Chip>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.group}>
        <legend className={styles.label}>What do you have available?</legend>
        <div className={styles.chips}>
          {contexts.map((context) => (
            <Chip
              key={context.id}
              pressed={draft.contexts.includes(context.id)}
              onClick={() => onChange(toggleDisruptionContext(draft, context.id))}
            >
              {context.name}
            </Chip>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.group}>
        <legend className={styles.label}>Does it take all of you?</legend>
        <div className={styles.chips}>
          <Chip pressed={draft.exclusive === true} onClick={() => onChange({ ...draft, exclusive: true })}>
            Yes, all of me
          </Chip>
          <Chip pressed={draft.exclusive === false} onClick={() => onChange({ ...draft, exclusive: false })}>
            No, I could do other things
          </Chip>
        </div>
      </fieldset>
    </>
  );
}
