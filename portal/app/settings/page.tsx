"use client";

import { PageHeader } from "@/components/ui/page-header";
import { SettingsRows } from "@/features/settings/components/settings-rows";

/**
 * Every setting, as the same seven rows You lists. A row with several pages opens the first and shows
 * the rest as tabs (`features/settings/settings-sections.ts`), so nothing here is a single card
 * repeating its own title.
 */
export default function SettingsPage() {
  return (
    <main className="content-page settings-page">
      <PageHeader title="Settings" answer="Seven groups of settings; each page saves on its own." />
      <SettingsRows />
    </main>
  );
}
