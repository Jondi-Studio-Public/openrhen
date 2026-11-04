"use client";

import { useCallback, useEffect, useState } from "react";
import { usePortal } from "@/state/portal-provider";
import { createClientId } from "@/shared/client-id";

/**
 * Settings → Pulse: the publish toggle, the
 * configured tracker's host, a live preview of exactly what the next publish would send, and the
 * last delivery. The portal never holds the tracker URL or the signing secret — both live only in
 * the outbound proxy — so this page only ever asks it `GET /api/pulse/config` and shows what comes
 * back.
 */

interface PulseConfig {
  configured: boolean;
  host: string | null;
}

interface PulsePreviewDoing {
  kind: string;
  title: string;
}

interface PulsePreview {
  v: 1;
  seq: number;
  generatedAt: string;
  state: "on" | "off" | "free" | "asleep";
  since: string;
  doing?: PulsePreviewDoing;
  private: boolean;
  lastConfirmedAt?: string;
  shares: {
    today: { onPercent: number | null; countedMinutes: number };
    days7: { onPercent: number | null; countedMinutes: number };
    days30: { onPercent: number | null; countedMinutes: number };
  };
}

interface PulsePreviewResponse {
  pulse: PulsePreview | null;
  lastPublishedAt: string | null;
  lastPublishOutcome: string | null;
  lastPublishError: string | null;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function stateLabel(pulse: PulsePreview): string {
  const base =
    pulse.state === "on" ? "On plan" : pulse.state === "off" ? "Off plan" : pulse.state === "free" ? "Free" : "Asleep";
  if (pulse.state !== "on") return base;
  if (pulse.private) return `${base} · private`;
  return pulse.doing ? `${base} · ${pulse.doing.title}` : base;
}

export function PulsePublishSection() {
  const { state, saving, saveEntityCommand } = usePortal();
  const [config, setConfig] = useState<PulseConfig>({ configured: false, host: null });
  const [preview, setPreview] = useState<PulsePreviewResponse | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [configResponse, previewResponse] = await Promise.all([
        fetch("/api/pulse/config"),
        fetch("/api/pulse/preview")
      ]);
      setConfig((await configResponse.json()) as PulseConfig);
      setPreview((await previewResponse.json()) as PulsePreviewResponse);
    } catch {
      setError("Could not reach the pulse service.");
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- sets state only after the awaited request settles
    void refresh();
  }, [refresh]);

  async function toggle(enabled: boolean) {
    setError("");
    try {
      await saveEntityCommand({
        commandId: createClientId(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "settings",
        entity: { pulsePublishEnabled: enabled }
      });
      await refresh();
    } catch {
      setError("Could not save the pulse publishing setting.");
    }
  }

  const enabled = state.settings.pulsePublishEnabled;

  return (
    <section className="more-group" id="pulse">
      <div className="section-heading">
        <h2>Pulse</h2>
      </div>
      <p className="reason">
        Publishes a redacted on-plan/off-plan reading to a tracker friends and family can watch. Only the state, what
        it's called, and the shares below ever leave the portal — never an id, a location, or a private target's title.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <label className="field">
        <span>Publish</span>
        <span className="checkbox-row">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(event) => void toggle(event.target.checked)}
          />{" "}
          Send to the configured tracker
        </span>
      </label>
      <p className="microcopy">
        {config.configured && config.host ? `Sending to ${config.host}.` : "No tracker URL set."}
      </p>
      {preview?.pulse ? (
        <div className="settings-preview">
          <p>
            <strong>Preview:</strong> {stateLabel(preview.pulse)}
          </p>
          <table className="settings-table">
            <tbody>
              <tr>
                <td>Today</td>
                <td>
                  {preview.pulse.shares.today.onPercent === null ? "n/a" : `${preview.pulse.shares.today.onPercent}%`}
                </td>
              </tr>
              <tr>
                <td>7 days</td>
                <td>
                  {preview.pulse.shares.days7.onPercent === null ? "n/a" : `${preview.pulse.shares.days7.onPercent}%`}
                </td>
              </tr>
              <tr>
                <td>30 days</td>
                <td>
                  {preview.pulse.shares.days30.onPercent === null ? "n/a" : `${preview.pulse.shares.days30.onPercent}%`}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p className="microcopy">Not recorded yet.</p>
      )}
      <p className="microcopy">
        Last delivery:{" "}
        {preview?.lastPublishOutcome === "delivered"
          ? relativeTime(preview.lastPublishedAt)
          : preview?.lastPublishOutcome
            ? `attempted, ${preview.lastPublishOutcome}`
            : "never"}
      </p>
    </section>
  );
}
