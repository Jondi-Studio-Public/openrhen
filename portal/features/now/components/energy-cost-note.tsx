import type { EnergyCostAnswer } from "@openrhen/contracts";
import styles from "./energy-cost-note.module.css";

/**
 * What declared low energy is holding back, as one plain line beside the stretch card. It describes and never
 * prescribes: the sentence is the server's (`energyCostText`), shown as given, with no button and no emphasis.
 */
export function EnergyCostNote({ energyCost }: { energyCost: EnergyCostAnswer | null }) {
  if (!energyCost) return null;
  return (
    <p className={styles.note} data-testid="energy-cost-note">
      {energyCost.text}
    </p>
  );
}
