"use client";

import { useState, type FormEvent } from "react";
import { usePortal } from "@/state/portal-provider";
import { AiModelSection } from "@/features/settings/components/ai-model-section";
import type { PlanningSettings } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { isVersionConflictError, useServerDraft } from "@/shared/use-server-draft";
import { AgentTokensCard } from "@/features/agent-tokens/components/agent-tokens-card";
import { ConnectedAddonsPanel } from "@/features/plan-map/components/addons-panel";
import { CodePatternCard } from "@/features/plan-map/components/code-pattern-card";
import { SettingsHead } from "@/features/settings/components/settings-head";

/** The OpenAI model each user-facing AI tool calls. Unset means "use the built-in default". */
export default function AiSettingsPage() {
  const { state, ready, saving, saveEntityCommand } = usePortal();
  const { draft, setDraft, resetDraft, markPristine, seededVersion } = useServerDraft<PlanningSettings>(
    state.settings,
    ready,
    state.settings.version ?? null
  );
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const patch = (change: Partial<PlanningSettings>) => setDraft({ ...draft, ...change });

  async function save(expectedVersion: number | null) {
    await saveEntityCommand({
      commandId: createClientId(),
      expectedVersion,
      type: "save_entity",
      entityType: "settings",
      entity: {
        deliverableChatModel: draft.deliverableChatModel ?? "",
        importExtractorModel: draft.importExtractorModel ?? ""
      }
    });
    markPristine();
    setError("");
    setConflict(false);
    setSaved(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await save(seededVersion);
    } catch (reason) {
      if (isVersionConflictError(reason)) {
        setConflict(true);
        setSaved(false);
        return;
      }
      setError(reason instanceof Error ? reason.message : "AI model settings were not saved.");
      setSaved(false);
    }
  }

  const reload = () => {
    resetDraft(state.settings);
    setConflict(false);
  };
  const keepMine = async () => {
    try {
      await save(state.settings.version ?? null);
    } catch (reason) {
      if (!isVersionConflictError(reason)) {
        setError(reason instanceof Error ? reason.message : "AI model settings were not saved.");
      }
    }
  };

  return (
    <main className="content-page settings-page">
      <SettingsHead
        href="/settings/ai"
        answer="Which model each AI tool uses, the plan map add-ons, and the tokens agents sign in with."
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <div className="form-error" role="alert">
          <p>These settings changed on another device.</p>
          <button type="button" className="quiet small" onClick={reload}>
            Reload
          </button>
          <button type="button" className="quiet small" onClick={keepMine}>
            Keep mine
          </button>
        </div>
      )}
      {saved && (
        <p className="save-notice" role="status">
          AI model settings saved.
        </p>
      )}
      <form className="settings-form" onSubmit={submit}>
        <AiModelSection draft={draft} onChange={patch} />
        <div className="settings-save">
          <button disabled={saving} type="submit">
            {saving ? "Saving…" : "Save AI models"}
          </button>
        </div>
      </form>
      <ConnectedAddonsPanel />
      <CodePatternCard />
      <AgentTokensCard />
    </main>
  );
}
