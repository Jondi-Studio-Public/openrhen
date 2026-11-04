"use client";

import { createClientId } from "@/shared/client-id";
import type { StayUpOffer as StayUpOfferData } from "@openrhen/contracts";
import type { StoredSleepPlan } from "@/state/portal-state";
import { clock } from "@/features/now/now-formatting";
import type { SaveEntityCommand } from "@/features/now/now-model";

/**
 * A behind project's offer to trade tonight's bedtime for its next ready action
 * Shown at most once per night, only while
 * `stayUpOffer` is present — the engine itself withdraws it once any of its five conditions stop
 * holding, or once `sleep_plan.stay_up_answer_minutes` is no longer null.
 */
export function StayUpOffer({
  offer,
  sleepDue,
  timezone,
  saving,
  saveEntityCommand
}: {
  offer: StayUpOfferData;
  sleepDue: StoredSleepPlan;
  timezone: string;
  saving: boolean;
  saveEntityCommand: SaveEntityCommand;
}) {
  const answer = (payload: Record<string, unknown>) =>
    void saveEntityCommand({
      commandId: createClientId(),
      expectedVersion: sleepDue.version ?? null,
      type: "save_entity",
      entityType: "sleep_plan",
      entity: { id: sleepDue.id, ...payload }
    });
  const accept = (choice: (typeof offer.choices)[number]) =>
    answer({
      plannedStartAt: choice.bedtimeAt,
      plannedWakeAt: choice.wakeAt,
      stayUpAnswerMinutes: choice.minutes
    });
  const decline = () => answer({ stayUpAnswerMinutes: 0 });
  return (
    <section className="sleep-warning" role="alert">
      <h2>
        {offer.projectTitle} is behind. Stay up to work on {offer.actionTitle}?
      </h2>
      <div className="actions">
        {offer.choices.map((choice) => (
          <button key={choice.minutes} disabled={saving} onClick={() => accept(choice)}>
            {choice.minutes} min — bed at {clock(new Date(choice.bedtimeAt), timezone)}, {choice.sleepMinutes} minutes
            sleep
          </button>
        ))}
        <button className="quiet" disabled={saving} onClick={decline}>
          Not tonight
        </button>
      </div>
    </section>
  );
}
