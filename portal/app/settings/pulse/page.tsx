"use client";

import { SettingsHead } from "@/features/settings/components/settings-head";
import { PulseThresholdsSection } from "@/features/settings/components/pulse-thresholds-section";
import { PulsePublishSection } from "@/features/settings/components/pulse-publish-section";

/**
 * Settings → Pulse (the pulse criteria and publish design note; the thresholds, the pulse on plan design note). Its own page, like Notifications,
 * because the toggle, the preview and the last delivery are all read live rather than saved as part
 * of a bigger form.
 */
export default function PulseSettingsPage() {
  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/pulse"
        answer="When the plan loses track of you, and the on-plan reading friends and family see."
      />
      <PulseThresholdsSection />
      <PulsePublishSection />
    </main>
  );
}
