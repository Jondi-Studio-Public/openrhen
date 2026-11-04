import { Badge } from "@/components/ui/badge";
import { ASSUMED_LABEL } from "@/features/plan/assumed-fields";

/** A small "assumed" label beside a value that is a default or a guess nobody has confirmed. */
export function AssumedTag() {
  return (
    <Badge dot={false} title="A default or a guess, not something you said. Change the value to confirm it.">
      {ASSUMED_LABEL}
    </Badge>
  );
}
