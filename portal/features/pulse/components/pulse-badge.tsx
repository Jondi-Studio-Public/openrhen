import { Badge } from "@/components/ui/badge";
import { pulseChip, type PulseReading } from "../pulse-view";

/** The pulse as a pill: on plan, not sure, off plan or lost track. Renders nothing before the recorder's first read. */
export function PulseBadge({ pulse }: { pulse: PulseReading | undefined }) {
  const chip = pulseChip(pulse);
  if (!chip) return null;
  return <Badge tone={chip.tone}>{chip.label}</Badge>;
}
