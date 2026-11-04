"use client";

import { displayLocale } from "@/shared/locale";
import { useEffect, useState } from "react";
import type { OwnerCredentialSummary, OwnerSessionInfo } from "@openrhen/contracts";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
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
const live = (credential: OwnerCredentialSummary) => !credential.revokedAt;

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/owner/session", { cache: "no-store" });
        if (!response.ok) throw new Error("not ok");
        const info = (await response.json()) as OwnerSessionInfo;
        let list: OwnerCredentialSummary[] = [];
        if (info.canManage) {
          const listed = await fetch("/api/owner/credentials", { cache: "no-store" });
          if (listed.ok) list = ((await listed.json()) as { credentials?: OwnerCredentialSummary[] }).credentials ?? [];
        }
        if (cancelled) return;
        setSession(info);
        setCredentials(list);
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
                {credential.expiresAt ? ` · expires ${day(credential.expiresAt)}` : ""}
              </span>
            }
            trailing={
              <span className={styles.trail}>
                <Badge tone={credential.current ? "accent" : "neutral"}>
                  {credential.current ? "this browser" : credential.kind === "token" ? "owner token" : "browser"}
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
    </Card>
  );
}
