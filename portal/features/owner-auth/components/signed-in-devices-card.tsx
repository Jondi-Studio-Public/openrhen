"use client";

import { displayLocale } from "@/shared/locale";
import { useEffect, useState } from "react";
import type { OwnerCredentialEvent, OwnerCredentialSummary, OwnerSessionInfo } from "@openrhen/contracts";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { clearSignedInMark } from "../signed-in-marker";
import styles from "./signed-in-devices-card.module.css";

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(displayLocale(), { day: "numeric", month: "short", year: "numeric" })
    : "never";
/** What each mode means for this browser, in words the person sees. */
const MODE_TEXT: Record<OwnerSessionInfo["mode"], { name: string; detail: string }> = {
  require: { name: "required", detail: "Every read and write needs a signed-in browser or an owner token." },
  shadow: {
    name: "logged, not enforced",
    detail: "Requests without a token still work as you, and are logged. Sign-in is not enforced on this server yet."
  },
  off: {
    name: "off",
    detail: "Sign-in is off on this server, so anything without a token is treated as you."
  }
};
/** A web-view session is part of its device, so it is not listed on its own. */
const live = (credential: OwnerCredentialSummary) => !credential.revokedAt && !credential.parentCredentialId;
const EVENT_TEXT: Record<OwnerCredentialEvent["event"], string> = {
  pairing_started: "QR shown",
  code_started: "asked for a code",
  code_approved: "code approved",
  code_denied: "code denied",
  redeemed: "signed in",
  revoked: "revoked"
};
const when = (iso: string) =>
  new Date(iso).toLocaleString(displayLocale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

interface ShownPairing {
  host: string;
  svg: string;
  expiresAt: string;
}

/**
 * Settings > Sign-in and devices: "Signed-in devices" (the design notes, decision D2). Shows who is
 * signed in, signs this browser out, and revokes any signed-in browser or owner token. There is no enrol button: a
 * browser signs in on the Sign in page (`SignInRequired`) with a token, and owner tokens are made by the CLI
 * (`rhen owner-token create`), so a secret is never on a web page.
 */
export function SignedInDevicesCard() {
  const [session, setSession] = useState<OwnerSessionInfo | null>(null);
  const [credentials, setCredentials] = useState<OwnerCredentialSummary[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [events, setEvents] = useState<OwnerCredentialEvent[]>([]);
  const [pairing, setPairing] = useState<ShownPairing | null>(null);
  const [askOrigin, setAskOrigin] = useState(false);
  const [typedOrigin, setTypedOrigin] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/owner/session", { cache: "no-store" });
        if (!response.ok) throw new Error("not ok");
        const info = (await response.json()) as OwnerSessionInfo;
        let list: OwnerCredentialSummary[] = [];
        let recent: OwnerCredentialEvent[] = [];
        if (info.canManage) {
          const listed = await fetch("/api/owner/credentials", { cache: "no-store" });
          if (listed.ok) list = ((await listed.json()) as { credentials?: OwnerCredentialSummary[] }).credentials ?? [];
          const history = await fetch("/api/owner/credential-events", { cache: "no-store" }).catch(() => null);
          if (history?.ok) recent = ((await history.json()) as { events?: OwnerCredentialEvent[] }).events ?? [];
        }
        if (cancelled) return;
        setSession(info);
        setCredentials(list);
        setEvents(recent);
        setError("");
      } catch {
        if (!cancelled) setError("Owner sign-in could not be read just now.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  const send = async (url: string, init: RequestInit, failure: string): Promise<boolean> => {
    setBusy(true);
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? failure);
      } else {
        setError("");
        setReloads((count) => count + 1);
        return true;
      }
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
    return false;
  };

  const signOut = async () => {
    // Signing out is deliberate: the next visit is a fresh sign-in, not an expired one.
    if (await send("/api/owner/signout", { method: "POST" }, "Could not sign out.")) clearSignedInMark();
  };
  const revoke = (credential: OwnerCredentialSummary) =>
    send(`/api/owner/credentials/${credential.id}`, { method: "DELETE" }, `Could not revoke ${credential.label}.`);

  /** Asks for a QR. Without a configured public address the owner types the https address for this one QR. */
  const addPhone = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/owner/devices/pairings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(typedOrigin.trim() ? { origin: typedOrigin.trim() } : {})
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        needsOrigin?: boolean;
        payload?: string;
        host?: string;
        expiresAt?: string;
      };
      if (!response.ok || !body.payload) {
        setPairing(null);
        setAskOrigin(Boolean(body.needsOrigin) || askOrigin);
        setError(body.error ?? "Could not start adding a phone.");
        return;
      }
      const { toString } = await import("qrcode");
      const svg = await toString(body.payload, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      setPairing({ host: body.host ?? "", svg, expiresAt: body.expiresAt ?? "" });
      setError("");
      setReloads((count) => count + 1);
    } catch {
      setError("Could not start adding a phone.");
    } finally {
      setBusy(false);
    }
  };

  const current = credentials.find((credential) => credential.current);
  // Looked up defensively: an older server, or a response that is not the session at all, has no mode.
  const mode = session ? MODE_TEXT[session.mode] : undefined;
  return (
    <Card as="section" className={styles.card} aria-labelledby="signed-in-heading">
      <CardHeader title={<span id="signed-in-heading">Signed-in devices</span>} />
      <p className={styles.note}>
        Owner sign-in is <strong>{mode?.name ?? "…"}</strong>. {mode?.detail ?? ""}
      </p>
      {error && (
        <Banner tone="danger" className={styles.banner}>
          {error}
        </Banner>
      )}
      {session && session.mode !== "require" && (
        <p className={styles.note}>
          This server doesn&apos;t require sign-in, so a phone&apos;s token is not what protects it. A paired phone is
          limited (it cannot add phones or issue tokens), but that limit protects nothing until sign-in is required.
        </p>
      )}
      {session?.canManage && !session.limited && (
        <div className={styles.actions}>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void addPhone()}>
            Add a phone
          </Button>
          <ButtonLink href="/settings/advanced/approve" variant="secondary" size="sm">
            Enter a code
          </ButtonLink>
        </div>
      )}
      {askOrigin && !pairing && (
        <div className={styles.note}>
          <label>
            The https address your phone will use to reach this portal
            <input
              className={styles.input}
              type="url"
              inputMode="url"
              placeholder="https://portal.example.com"
              value={typedOrigin}
              onChange={(event) => setTypedOrigin(event.target.value)}
            />
          </label>{" "}
          <Button size="sm" disabled={busy || !typedOrigin.trim()} onClick={() => void addPhone()}>
            Show QR
          </Button>
        </div>
      )}
      {pairing && (
        <div className={styles.pairing}>
          <div
            className={styles.qr}
            role="img"
            aria-label="QR code to add a phone"
            dangerouslySetInnerHTML={{ __html: pairing.svg }}
          />
          <p className={styles.host}>{pairing.host}</p>
          <p className={styles.note}>
            Scan this with the app on the phone and check that it shows the name above. It works once
            {pairing.expiresAt ? `, until ${when(pairing.expiresAt)}` : ""}.
          </p>
          <Button variant="ghost" size="sm" onClick={() => setPairing(null)}>
            Done
          </Button>
        </div>
      )}
      {session?.signedIn && session.via === "cookie" && (
        <p className={styles.note}>
          This browser is signed in{current && current.label !== "This browser" ? ` as ${current.label}` : ""}.{" "}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void signOut()}>
            Sign out
          </Button>
        </p>
      )}
      {session?.canManage && credentials.filter(live).length === 0 && (
        <p className={styles.note}>Nothing signed in yet.</p>
      )}
      <List>
        {credentials.filter(live).map((credential) => (
          <ListRow
            key={credential.id}
            title={credential.label}
            meta={
              <span className={styles.line}>
                Last used {day(credential.lastUsedAt)}
                {credential.lastUsedFrom ? ` from ${credential.lastUsedFrom}` : ""}
                {credential.expiresAt ? ` · expires ${day(credential.expiresAt)}` : ""}
                {credential.limited ? " · limited" : ""}
              </span>
            }
            trailing={
              <span className={styles.trail}>
                <Badge tone={credential.current ? "accent" : "neutral"}>
                  {credential.current
                    ? "this browser"
                    : credential.device
                      ? credential.device.platform
                      : credential.kind === "token"
                        ? "owner token"
                        : "browser"}
                </Badge>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  aria-label={`Revoke ${credential.label}`}
                  onClick={() => void revoke(credential)}
                >
                  Revoke
                </Button>
              </span>
            }
          />
        ))}
      </List>
      {events.length > 0 && (
        <>
          <p className={styles.note}>Recent activity</p>
          <List>
            {events.slice(0, 8).map((event) => (
              <ListRow
                key={event.id}
                title={`${event.label ?? "A device"} · ${EVENT_TEXT[event.event]}`}
                meta={
                  <span className={styles.line}>
                    {when(event.occurredAt)}
                    {event.address ? ` · from ${event.address}` : ""}
                  </span>
                }
              />
            ))}
          </List>
        </>
      )}
    </Card>
  );
}
