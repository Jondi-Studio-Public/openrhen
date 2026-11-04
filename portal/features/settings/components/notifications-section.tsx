"use client";

import { useCallback, useEffect, useState } from "react";
import { usePortal } from "@/state/portal-provider";
import { createClientId } from "@/shared/client-id";

/**
 * Settings -> Notifications. Owns the whole push
 * lifecycle client-side: registering `public/push-sw.js`, requesting permission, subscribing,
 * "Send a test", and the device list -- plus "Remind me before leaving", which is an ordinary settings
 * field that happens to live on this page because that's where it's used.
 *
 * States, in the order the design lists them: needs a Home Screen install (iOS, not standalone), not
 * supported (no ServiceWorkerRegistration/PushManager at all), blocked (`Notification.permission ===
 * "denied"`), off (never subscribed, or the subscription this device holds does not appear in the
 * server's own list), on (a matching subscription is listed).
 */

type Status = "checking" | "needs-install" | "not-supported" | "blocked" | "off" | "on";

interface DeviceRow {
  id: string;
  label: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

function isIosStandaloneCandidate(): boolean {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    // Safari's own non-standard flag, present only on iOS before the display-mode media query existed
    // for it -- still the more reliable signal on some iOS versions.
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return isIos && !isStandalone;
}

function base64UrlToUint8Array(base64Url: string): BufferSource {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iphone/i.test(ua)) return "iPhone";
  if (/ipad/i.test(ua)) return "iPad";
  if (/android/i.test(ua)) return "Android";
  return "This device";
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

function formatAdded(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "unknown"
    : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function NotificationsSection() {
  const { state, saving, saveEntityCommand } = usePortal();
  const [status, setStatus] = useState<Status>("checking");
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<"idle" | "sent" | "failed">("idle");
  const [leadMinutes, setLeadMinutes] = useState(state.settings.leaveByLeadMinutes);
  const [leadSaved, setLeadSaved] = useState(false);

  const refresh = useCallback(async () => {
    if (isIosStandaloneCandidate()) return setStatus("needs-install");
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return setStatus("not-supported");
    if (Notification.permission === "denied") return setStatus("blocked");
    try {
      const registration = await navigator.serviceWorker.getRegistration("/push-sw.js");
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      const response = await fetch("/api/push/subscriptions");
      const body = (await response.json()) as { available: boolean; subscriptions: DeviceRow[] };
      setDevices(body.subscriptions);
      const listed = subscription ? body.subscriptions.length > 0 : false;
      setStatus(subscription && listed ? "on" : "off");
    } catch {
      setStatus("off");
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- sets state only after the awaited request settles
    void refresh();
  }, [refresh]);

  async function turnOn() {
    setBusy(true);
    setError("");
    try {
      const configResponse = await fetch("/api/push/config");
      const config = (await configResponse.json()) as { available: boolean; publicKey: string | null };
      if (!config.available || !config.publicKey) {
        setError("The push service is not reachable right now.");
        return;
      }
      await navigator.serviceWorker.register("/push-sw.js");
      // `pushManager.subscribe` requires an *active* worker, not merely a registered one — awaiting
      // `.ready` (which resolves once install/activate finish) is what makes the very first "Turn on"
      // reliable rather than racing the worker's own activation.
      const registration = await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "blocked" : "off");
        return;
      }
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(config.publicKey)
      });
      const response = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          vapidPublicKey: config.publicKey,
          label: deviceLabel()
        })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(response.status === 409 && body?.error ? body.error : "The subscription could not be saved.");
        return;
      }
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Turning on notifications failed.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError("");
    try {
      const registration = await navigator.serviceWorker.getRegistration("/push-sw.js");
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (subscription) {
        await fetch("/api/push/subscriptions", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint })
        });
        await subscription.unsubscribe();
      }
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Turning off notifications failed.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setTestResult("idle");
    setError("");
    try {
      const response = await fetch("/api/push/test", { method: "POST" });
      setTestResult(response.ok ? "sent" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeDevice(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/push/subscriptions/${id}`, { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveLead(event: React.FormEvent) {
    event.preventDefault();
    await saveEntityCommand({
      commandId: createClientId(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { leaveByLeadMinutes: leadMinutes }
    });
    setLeadSaved(true);
  }

  return (
    <section className="more-group" id="notifications">
      <div className="section-heading">
        <h2>Notifications</h2>
      </div>
      <p className="reason">
        A leave-by reminder when Now is not open -- installed as an app and turned on per device.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {status === "checking" && <p className="microcopy">Checking this device…</p>}
      {status === "needs-install" && (
        <p className="microcopy">
          Add OpenRhen to your Home Screen first — iOS only delivers push to the installed app.
        </p>
      )}
      {status === "not-supported" && <p className="microcopy">This browser does not support push notifications.</p>}
      {status === "blocked" && (
        <p className="microcopy">Notifications are blocked in this browser's site settings for OpenRhen.</p>
      )}
      {status === "off" && (
        <button type="button" disabled={busy} onClick={() => void turnOn()}>
          {busy ? "Turning on…" : "Turn on for this device"}
        </button>
      )}
      {status === "on" && (
        <div className="actions">
          <button type="button" className="quiet" disabled={busy} onClick={() => void turnOff()}>
            Turn off
          </button>
          <button type="button" className="quiet" disabled={busy} onClick={() => void sendTest()}>
            Send a test
          </button>
        </div>
      )}
      {testResult === "sent" && (
        <p className="save-notice" role="status">
          Test push sent.
        </p>
      )}
      {testResult === "failed" && (
        <p className="form-error" role="alert">
          No device received it. Turn on notifications for this device first.
        </p>
      )}
      {devices.length > 0 && (
        <table className="settings-table">
          <tbody>
            {devices.map((device) => (
              <tr key={device.id}>
                <td>{device.label ?? "Device"}</td>
                <td>Added {formatAdded(device.createdAt)}</td>
                <td>Last delivery: {relativeTime(device.lastSuccessAt)}</td>
                <td>
                  <button
                    type="button"
                    className="quiet small"
                    disabled={busy}
                    onClick={() => void removeDevice(device.id)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="settings-form" onSubmit={(event) => void saveLead(event)}>
        <label htmlFor="leave-by-lead-minutes">Remind me before leaving (minutes)</label>
        <input
          id="leave-by-lead-minutes"
          type="number"
          min={0}
          max={60}
          step={1}
          value={leadMinutes}
          onChange={(event) => {
            setLeadSaved(false);
            setLeadMinutes(Number(event.target.value));
          }}
        />
        <div className="settings-save">
          <button disabled={saving} type="submit">
            {saving ? "Saving…" : "Save"}
          </button>
          {leadSaved && <span className="save-notice">Saved</span>}
        </div>
      </form>
    </section>
  );
}
