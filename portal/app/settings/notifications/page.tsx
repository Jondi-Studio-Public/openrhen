"use client";

import { SettingsHead } from "@/features/settings/components/settings-head";
import { NotificationsSection } from "@/features/settings/components/notifications-section";

/**
 * Settings -> Notifications. Its own page, like every other settings
 * row under You.
 */
export default function NotificationsSettingsPage() {
  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/notifications"
        answer="Leave-by alerts on this device, and how much warning you get."
      />
      <NotificationsSection />
    </main>
  );
}
