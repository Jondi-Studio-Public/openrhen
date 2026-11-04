"use client";

import { usePortal } from "@/state/portal-provider";
import { clock } from "@/features/now/now-formatting";
import { openCaptureSheet } from "@/shared/use-capture-sheet";
import { resolveCommitmentContact } from "@/features/commitments/commitment-contact";
import type { DisruptionPreset } from "@/shared/capture-sheet";

/**
 * **Let <name> know?**, or the generic **Let someone know?** when the commitment's contact does not
 * resolve — the one offer every placement uses, so naming and
 * behaviour never drift between the arrival projection, running late, a displaced commitment, and the
 * cancel confirmation. It reads state itself (`usePortal()`), so a caller only ever names which
 * commitment this is about; `app/page.tsx` does not change.
 *
 * Clicking it opens the existing **Something came up** sheet with the contact pre-chosen and a line
 * naming the commitment ("About Dentist at 10:00"). `reason` (and `lateMinutes` when running late)
 * rides along so the sheet can draft the message. Nothing is sent
 * either way: at most the sheet opens the person's own text or email app with the message written.
 */
export function LetSomeoneKnow({
  commitmentId,
  reason,
  lateMinutes
}: {
  commitmentId: string;
  reason?: DisruptionPreset["reason"];
  lateMinutes?: number;
}) {
  const { state } = usePortal();
  const commitment = state.commitments.find((item) => item.id === commitmentId);
  if (!commitment) return null;
  const contact = resolveCommitmentContact(commitment, state.conditionDefinitions);
  const about = `${commitment.title} at ${clock(new Date(commitment.startsAt), state.settings.timezone)}`;
  return (
    <button
      type="button"
      className="quiet"
      onClick={() =>
        openCaptureSheet("disruption", {
          ...(contact ? { contactId: contact.id } : {}),
          about,
          ...(reason ? { reason } : {}),
          ...(lateMinutes && lateMinutes > 0 ? { lateMinutes } : {})
        })
      }
    >
      {contact ? `Let ${contact.name} know?` : "Let someone know?"}
    </button>
  );
}
