"use client";

import { SignedInDevicesCard } from "@/features/owner-auth/components/signed-in-devices-card";
import { SettingsHead } from "@/features/settings/components/settings-head";

/** Settings -> Sign-in and devices: the browsers and phones signed in as you. Agent tokens and the plan map
 * add-ons live with AI and add-ons. The address stays /settings/advanced so old links still land here. */
export default function SignInSettingsPage() {
  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/advanced"
        answer="The browsers and phones signed in as you, and how to add another."
      />
      <SignedInDevicesCard />
    </main>
  );
}
