"use client";

import { useCallback, useEffect, useState } from "react";
import { createClientId } from "@/shared/client-id";
import { WorkLabelChip } from "@/features/plan/components/work-label-chip";
import {
  fetchWorkLabels,
  putWorkLabel,
  type WorkLabelAnswer,
  type WorkLabelView
} from "@/features/plan/work-label-client";

/** The work-label line on an area's page: loads the label, and writes the owner's tap through the server route. */
export function AreaWorkLabel({ areaId }: { areaId: string }) {
  const [label, setLabel] = useState<WorkLabelView | null>(null);
  const [modelConfigured, setModelConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorState, setError] = useState<{ areaId: string; message: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetchWorkLabels().then(
      (answer) => {
        if (!live) return;
        setModelConfigured(answer.modelConfigured);
        setLabel(
          answer.labels.find((item) => item.areaId === areaId) ?? { areaId, value: "unknown", origin: null, at: null }
        );
      },
      (failure: unknown) => {
        if (!live) return;
        setLabel({ areaId, value: "unknown", origin: null, at: null });
        setError({ areaId, message: failure instanceof Error ? failure.message : "The label could not be loaded." });
      }
    );
    return () => {
      live = false;
    };
  }, [areaId]);

  const choose = useCallback(
    (answer: WorkLabelAnswer) => {
      setBusy(true);
      setError(null);
      putWorkLabel(areaId, answer, createClientId()).then(
        (saved) => {
          setLabel(saved);
          setBusy(false);
        },
        (failure: unknown) => {
          setError({
            areaId,
            message: failure instanceof Error ? failure.message : "The answer was not saved. Try again."
          });
          setBusy(false);
        }
      );
    },
    [areaId]
  );

  // A different area must not show the last one's label or error while its own loads.
  const shown = label?.areaId === areaId ? label : null;
  const error = errorState?.areaId === areaId ? errorState.message : null;
  return <WorkLabelChip label={shown} modelConfigured={modelConfigured} busy={busy} error={error} onChoose={choose} />;
}
