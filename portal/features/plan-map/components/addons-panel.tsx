"use client";

import type { PlanMap, SwitchableAddon, PlanMapMode } from "@openrhen/contracts";
import { Banner } from "@/components/ui/banner";
import { Card } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { usePlanMap } from "@/features/plan-map/use-plan-map";
import { ADDON_LABELS, MODE_LABELS, modeOptions, switchRows } from "@/features/plan-map/plan-map-model";
import styles from "./addons-panel.module.css";

/**
 * The add-on switches. Only the few add-ons that change a plan or a
 * ranking on their own, or that you turned off yourself, have one; the rest are always on. Each starts off
 * and only you turn one on. Only the add-ons whose text names a Test only option offer it.
 */
export function AddonsPanel({
  map,
  busy,
  error,
  onChange,
  open
}: {
  map: Pick<PlanMap, "switches"> | null;
  busy: boolean;
  error: string;
  onChange: (addon: SwitchableAddon, mode: PlanMapMode) => void;
  open?: boolean;
}) {
  const rows = switchRows(map);
  // Card types only HTMLAttributes, which have no `open`; <details> takes it.
  const detailsProps = { open } as object;
  return (
    <Card as="details" className={styles.panel} id="plan-map-addons" {...detailsProps}>
      <summary className={styles.summary}>Add-ons</summary>
      <p className={styles.note}>
        These add-ons change your plan or rankings on their own, so each is off until you turn it on. Everything else in
        the map just runs. Choose Test only to see what an add-on would suggest before you let it change anything.
      </p>
      {error && (
        <Banner tone="danger" className={styles.banner}>
          {error}
        </Banner>
      )}
      {!map && <p className={styles.note}>Switches load with the plan map. They read as off until then.</p>}
      <List>
        {rows.map(({ addon, mode }) => {
          const label = ADDON_LABELS[addon];
          const options = modeOptions(addon);
          return (
            <ListRow
              key={addon}
              title={label.name}
              meta={label.blurb}
              trailing={
                <select
                  aria-label={`${label.name} mode`}
                  value={mode}
                  disabled={busy || !map}
                  onChange={(event) => onChange(addon, event.target.value as PlanMapMode)}
                >
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {MODE_LABELS[option]}
                    </option>
                  ))}
                </select>
              }
            />
          );
        })}
      </List>
    </Card>
  );
}

/** The panel wired to its own plan-map store, for Settings; the Map page shares the same hook and endpoint. */
export function ConnectedAddonsPanel() {
  const planMap = usePlanMap();
  return (
    <AddonsPanel
      open
      map={planMap.map}
      busy={planMap.busy}
      error={planMap.switchError || (planMap.status === "error" ? planMap.error : "")}
      onChange={(addon, mode) => void planMap.setSwitch(addon, mode)}
    />
  );
}
