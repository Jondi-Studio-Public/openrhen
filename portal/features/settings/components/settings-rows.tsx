"use client";

import { Card } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { usePortal } from "@/state/portal-provider";
import { clockLabel, settingsSections } from "../settings-sections";

/**
 * The seven settings rows, each opening its first page. Sleep says the times it holds, because that is
 * the one setting people check rather than change; the rest say what is inside.
 */
export function SettingsRows() {
  const { state } = usePortal();
  const { preferredBedtime, preferredWakeTime } = state.settings;
  const sleepMeta =
    preferredBedtime && preferredWakeTime
      ? `Bed ${clockLabel(preferredBedtime)} · usual wake ${clockLabel(preferredWakeTime)}`
      : undefined;
  return (
    <Card>
      <List>
        {settingsSections.map((section) => (
          <ListRow
            key={section.id}
            href={section.pages[0]!.href}
            title={section.title}
            meta={section.id === "sleep" && sleepMeta ? sleepMeta : section.meta}
          />
        ))}
      </List>
    </Card>
  );
}
