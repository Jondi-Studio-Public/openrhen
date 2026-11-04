"use client";

import { useEffect, useState } from "react";
import {
  allDirectWritesOn,
  hasAllDirectWritesOn,
  type AgentTokenSummary,
  type OwnerSessionInfo
} from "@openrhen/contracts";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { Switch } from "@/components/ui/switch";
import styles from "./agent-tokens-card.module.css";
import { useNow } from "@/shared/clock";

/** The words for a token's state; a token is live until it is revoked or its expiry passes. */
export function tokenState(token: AgentTokenSummary, now: number): "active" | "expired" | "revoked" {
  if (token.revokedAt) return "revoked";
  return new Date(token.expiresAt).getTime() <= now ? "expired" : "active";
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "never");

/**
 * Settings > AI and add-ons: the agent tokens. Apart from Revoke and the
 * "Writes apply directly" switch it is read-only; issuing a token is the CLI's `rhen agent-token create`, so
 * a secret is never on a web page.
 */
export function AgentTokensCard() {
  const [tokens, setTokens] = useState<AgentTokenSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const [reloads, setReloads] = useState(0);
  // Whether sign-in is enforced decides if the "tokens do not bind an agent" line applies; unknown shows nothing.
  const [signInMode, setSignInMode] = useState<OwnerSessionInfo["mode"] | null>(null);
  const now = useNow("minute").getTime();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/agent-tokens", { cache: "no-store" });
        if (!response.ok) throw new Error("not ok");
        const body = (await response.json()) as { tokens?: AgentTokenSummary[] };
        if (cancelled) return;
        setTokens(Array.isArray(body.tokens) ? body.tokens : []);
        setError("");
      } catch {
        if (!cancelled) setError("Agent tokens could not be read just now.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/owner/session", { cache: "no-store" });
        if (!response.ok) return;
        const info = (await response.json()) as Partial<OwnerSessionInfo>;
        if (!cancelled && (info.mode === "require" || info.mode === "shadow" || info.mode === "off"))
          setSignInMode(info.mode);
      } catch {
        // The line is only a caution; without the mode it is left out.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const revoke = async (token: AgentTokenSummary) => {
    if (!window.confirm(`Revoke ${token.name}? The agent stops working on its next request.`)) return;
    setBusy(token.id);
    try {
      const response = await fetch(`/api/agent-tokens/${token.id}`, { method: "DELETE" });
      if (!response.ok) setError(`Could not revoke ${token.name}.`);
      else setReloads((count) => count + 1);
    } catch {
      setError(`Could not revoke ${token.name}.`);
    } finally {
      setBusy(null);
    }
  };

  // On means every entity class applies directly; off clears the map, so every write waits as a proposal again.
  const setDirectWrites = async (token: AgentTokenSummary, on: boolean) => {
    setBusy(token.id);
    try {
      const response = await fetch(`/api/agent-tokens/${token.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directWrites: on ? allDirectWritesOn() : {} })
      });
      if (!response.ok) setError(`Could not change ${token.name}.`);
      else {
        setError("");
        setReloads((count) => count + 1);
      }
    } catch {
      setError(`Could not change ${token.name}.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card as="section" className={styles.card} aria-labelledby="agent-tokens-heading">
      <CardHeader title={<span id="agent-tokens-heading">Agent tokens</span>} />
      <p className={styles.note}>
        Each token lets one agent read and file what its scopes allow. Create one with{" "}
        <code>rhen agent-token create</code>; a revoked token stops working on its next request. With writes applying
        directly, the agent changes your plan at once and every change is listed and undoable; deletes, settings and
        anything sent outward still wait for you.
      </p>
      {signInMode !== null && signInMode !== "require" && (
        <p className={styles.note}>
          Sign-in is {signInMode === "off" ? "off" : "not enforced"} on this server, so tokens do not bind a hostile or
          buggy agent: a caller that sends no identity, or only a name, is still treated as you.
        </p>
      )}
      {error && (
        <Banner tone="danger" className={styles.banner}>
          {error}
        </Banner>
      )}
      {tokens?.length === 0 && <p className={styles.note}>No agent tokens yet.</p>}
      <List>
        {(tokens ?? []).map((token) => {
          const state = tokenState(token, now);
          return (
            <ListRow
              key={token.id}
              title={token.name}
              meta={
                <>
                  <span className={styles.line}>{token.scopes.join(", ")}</span>
                  <span className={styles.line}>
                    Last used {day(token.lastUsedAt)} · expires {day(token.expiresAt)}
                  </span>
                </>
              }
              trailing={
                <span className={styles.trail}>
                  <Badge tone={state === "active" ? "accent" : state === "expired" ? "warn" : "neutral"}>{state}</Badge>
                  {state === "active" && (
                    <span className={styles.switchLabel}>
                      <Switch
                        checked={hasAllDirectWritesOn(token.directWrites)}
                        disabled={busy === token.id}
                        label={`Writes apply directly for ${token.name}`}
                        onChange={(on) => void setDirectWrites(token, on)}
                      />
                      Writes apply directly
                    </span>
                  )}
                  {state === "active" && (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy === token.id}
                      aria-label={`Revoke ${token.name}`}
                      onClick={() => void revoke(token)}
                    >
                      Revoke
                    </Button>
                  )}
                </span>
              }
            />
          );
        })}
      </List>
    </Card>
  );
}
