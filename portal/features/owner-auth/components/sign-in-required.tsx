"use client";

import { useId, useState, type FormEvent } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { markSignedIn } from "../signed-in-marker";
import styles from "./sign-in-required.module.css";

/** A name for this browser in Settings › Signed-in devices ("Safari on iPhone"), so two signed-in browsers can be
 * told apart. Read from the user agent; anything unrecognised falls back to "Browser". */
export function browserLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const device = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(userAgent)
            ? "Mac"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "";
  return device ? `${browser} on ${device}` : browser;
}

/**
 * What the app shows instead of any page when the portal requires an owner credential and this browser has none
 * (the server answered `/api/state` with 401). It renders and requests nothing else, so no
 * plan data is on the page before sign-in; enrolling reloads the page to start clean.
 */
export function SignInRequired({ expired = false }: { expired?: boolean }) {
  const id = useId();
  const [secret, setSecret] = useState("");
  // Null until the person types a name; then the default is this browser's own label.
  const [typedName, setTypedName] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const deviceName = typedName ?? (typeof navigator === "undefined" ? "" : browserLabel(navigator.userAgent));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!secret.trim()) return;
    setBusy(true);
    try {
      const response = await fetch("/api/owner/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: secret.trim(), label: deviceName.trim() || browserLabel(navigator.userAgent) })
      });
      if (response.ok) {
        markSignedIn();
        window.location.reload();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "This browser could not be signed in.");
    } catch {
      setError("Could not reach OpenRhen to sign in. Check that it is running and your connection, then try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.desk} aria-labelledby="sign-in-heading">
      <Card className={styles.card}>
        <span className={styles.mark} aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill="none"
            stroke="#fff"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        </span>
        <div className={styles.intro}>
          <h1 id="sign-in-heading" className={styles.title}>
            Sign in to OpenRhen
          </h1>
          <p className={styles.lead}>
            {expired
              ? "This browser's sign-in has expired. Paste a sign-in token to sign in again."
              : "This browser isn't signed in yet. Paste a sign-in token once and it stays signed in."}
          </p>
        </div>
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-token`}>
              Sign-in token
            </label>
            <input
              id={`${id}-token`}
              type="password"
              autoComplete="off"
              placeholder="Paste token"
              aria-describedby={`${id}-hint`}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <p id={`${id}-hint`} className={styles.hint}>
              {
                "Use the recovery token you stored when you turned sign-in on, or one made with `rhen owner-token create --label <device>`. The guide Locking down the API has the steps."
              }
            </p>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-device`}>
              Name this device
            </label>
            <input
              id={`${id}-device`}
              type="text"
              autoComplete="off"
              value={deviceName}
              onChange={(event) => {
                setTypedName(event.target.value);
              }}
            />
          </div>
          {error && (
            <Banner tone="danger" className={styles.error}>
              {error}
            </Banner>
          )}
          <Button
            variant="primary"
            size="lg"
            block
            type="submit"
            className={styles.submit}
            disabled={busy || !secret.trim()}
          >
            Sign in
          </Button>
        </form>
      </Card>
    </main>
  );
}
