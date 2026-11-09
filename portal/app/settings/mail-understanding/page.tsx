"use client";

import { MailUnderstandingSection } from "@/features/settings/components/mail-understanding-section";
import { SettingsHead } from "@/features/settings/components/settings-head";

/**
 * Settings, Mail understanding: the local model's address, the models, the hosted tier's daily limits and how far back
 * to read. Saved on its own (not part of the planning settings), and the hosted key lives on Passwords and keys.
 */
export default function MailUnderstandingPage() {
  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/mail-understanding"
        answer="Where the model that reads your mail runs, and how much may go to the hosted one."
      />
      <MailUnderstandingSection />
    </main>
  );
}
