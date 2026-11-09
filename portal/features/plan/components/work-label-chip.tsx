import { Chip } from "@/components/ui/chip";
import type { WorkLabelAnswer, WorkLabelView } from "@/features/plan/work-label-client";

/**
 * "Counts as work" for one area: what the detector thinks, in words, with one tap to say otherwise. The owner's tap is
 * kept as their own answer and wins over the model's; Reset takes it back. Nothing here is a setting: with no answer
 * and no model the line just says it is not decided yet.
 */
export function WorkLabelChip({
  label,
  modelConfigured,
  busy,
  error,
  onChoose
}: {
  /** Null while the label has not loaded. */
  label: WorkLabelView | null;
  modelConfigured: boolean;
  busy: boolean;
  error: string | null;
  onChoose: (answer: WorkLabelAnswer) => void;
}) {
  const value = label?.value ?? "unknown";
  const own = label?.origin === "corrected";
  const state =
    label === null
      ? "Loading…"
      : value === "unknown"
        ? modelConfigured
          ? "Not decided yet"
          : "Not decided yet (no local model is set)"
        : `${value === "work" ? "Yes" : "No"} (${own ? "your answer" : "inferred"})`;
  return (
    <div className="actions flush" role="group" aria-label="Counts as work">
      <p className="reason" role="status">
        Counts as work: {state}
      </p>
      <Chip
        pressed={own && value === "work"}
        disabled={busy || label === null}
        onClick={() => onChoose("work")}
        aria-label="Counts as work: yes"
      >
        Yes
      </Chip>
      <Chip
        pressed={own && value === "not_work"}
        disabled={busy || label === null}
        onClick={() => onChoose("not_work")}
        aria-label="Counts as work: no"
      >
        No
      </Chip>
      {own && (
        <button
          className="quiet small"
          aria-label="Counts as work: reset"
          disabled={busy}
          onClick={() => onChoose("unset")}
        >
          Reset
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
