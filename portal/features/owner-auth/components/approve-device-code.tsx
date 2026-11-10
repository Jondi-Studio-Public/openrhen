"use client";

import { useId, useState, type FormEvent } from "react";
import { Banner } from "@/components/ui/banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import styles from "./signed-in-devices-card.module.css";

interface Waiting {
  name: string;
  device: { installId: string; platform: string };
  requestedAt: string;
  from: string | null;
}

/**
 * Approves a device that showed a code (the fallback to scanning a QR). The owner types the code; there is no
 * prefilled link to follow, because following a link is how a code gets approved by someone who never saw the device.
 * The page shows who is asking before anything is approved.
 */
export function ApproveDeviceCode() {
  const id = useId();
  const [code, setCode] = useState("");
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [done, setDone] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const call = async (decision?: "approve" | "deny") => {
    setBusy(true);
    try {
      const response = await fetch("/api/owner/devices/code/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode: code.trim(), ...(decision ? { decision } : {}) })
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; pending?: Waiting };
      if (!response.ok) {
        setError(body.error ?? "Could not check that code.");
        if (!decision) setWaiting(null);
        return;
      }
      setError("");
      if (decision) setDone(decision);
      else setWaiting(body.pending ?? null);
    } catch {
      setError("Could not check that code.");
    } finally {
      setBusy(false);
    }
  };

  const look = (event: FormEvent) => {
    event.preventDefault();
    if (code.trim()) void call();
  };

  return (
    <Card as="section" className={styles.card} aria-labelledby={`${id}-heading`}>
      <CardHeader title={<span id={`${id}-heading`}>Enter a code</span>} />
      {error && (
        <Banner tone="danger" className={styles.banner}>
          {error}
        </Banner>
      )}
      {done ? (
        <div className={styles.pairing}>
          <p className={styles.note}>
            {done === "approve"
              ? `${waiting?.name ?? "The device"} is signed in. It collects its access in a few seconds.`
              : `${waiting?.name ?? "The device"} was turned away.`}
          </p>
          <ButtonLink href="/settings/advanced" size="sm">
            Back to devices
          </ButtonLink>
        </div>
      ) : waiting ? (
        <div className={styles.pairing}>
          <p className={styles.host}>{waiting.name}</p>
          <p className={styles.note}>
            A device called &ldquo;{waiting.name}&rdquo; ({waiting.device.platform}) asked to sign in
            {waiting.from ? ` from ${waiting.from}` : ""}. Approve only a code shown on a device in your hand.
          </p>
          <p className={styles.note}>
            Its install id ends {waiting.device.installId.slice(-4)}. Approving replaces any phone already signed in
            with that id.
          </p>
          <div className={styles.actions}>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void call("approve")}>
              Approve
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void call("deny")}>
              Deny
            </Button>
          </div>
        </div>
      ) : (
        <form className={styles.pairing} onSubmit={look}>
          <label className={styles.note} htmlFor={`${id}-code`}>
            The code the device is showing
          </label>
          <input
            id={`${id}-code`}
            className={styles.input}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="ABCD-EFGH"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" variant="primary" size="sm" disabled={busy || !code.trim()}>
            Look up
          </Button>
        </form>
      )}
    </Card>
  );
}
