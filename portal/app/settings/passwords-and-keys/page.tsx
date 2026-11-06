"use client";

import { SecretsSection } from "@/features/settings/components/secrets-section";
import { SettingsHead } from "@/features/settings/components/settings-head";

/**
 * Settings, Passwords and keys: write-only keys the app needs (today, the YouTube Data API key that supplies video
 * lengths for watch history). Saved encrypted, shown only as a status, never readable by an agent.
 */
export default function PasswordsAndKeysPage() {
  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/passwords-and-keys"
        answer="Keys the app needs for outside services. Write-only: once saved, a key is never shown again."
      />
      <SecretsSection />
    </main>
  );
}
