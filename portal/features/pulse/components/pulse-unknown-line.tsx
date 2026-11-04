"use client";

import { useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import type { PulseReading } from "../pulse-view";
import { DisruptionSheet } from "./disruption-sheet";

/**
 * The pulse is unknown but no check-in is waiting to be answered (the plan lost the thread some other way: a session
 * ran past its time, a stale wake). There is no check-in slot to tap Yes on and no write that counts as contact
 * without one, so the line says what counts: anything recorded. "Something else" opens the disruption form, which
 * records what you are doing instead. With a check-in waiting, `CheckInBanner` carries the "Still doing X?" line.
 */
export function PulseUnknownLine({ pulse }: { pulse: PulseReading }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Banner
        tone="warn"
        action={
          <Button size="sm" variant="secondary" aria-haspopup="dialog" onClick={() => setOpen(true)}>
            Something else
          </Button>
        }
      >
        {pulse.doing ? `Still doing ${pulse.doing.title}? ` : "Not sure what you're doing. "}
        Start, finish or pause something, or update where you are, and the plan carries on.
      </Banner>
      <DisruptionSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
