"use client";

import { ApproveDeviceCode } from "@/features/owner-auth/components/approve-device-code";
import { SettingsHead } from "@/features/settings/components/settings-head";

/** Settings > Sign-in and devices > Enter a code: approve a device that showed a code. The code is typed, never in a link. */
export default function ApproveDevicePage() {
  return (
    <main className="content-page settings-page">
      <SettingsHead href="/settings/advanced" answer="Type the code a device is showing to let it in." />
      <ApproveDeviceCode />
    </main>
  );
}
