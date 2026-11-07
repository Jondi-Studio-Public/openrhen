"use client";

import { useCallback, useEffect, useState } from "react";
import {
  SECRET_LABELS,
  SECRET_NAMES,
  secretsRefusalMessage,
  type SecretName,
  type SecretStatus,
  type SecretStatusResponse
} from "@openrhen/contracts";
import { Button } from "@/components/ui/button";
import { displayLocale } from "@/shared/locale";

/**
 * Settings, Passwords and keys. Write-only: a key is typed into a password field and sent once; the page then shows
 * only "Saved <date>", "Saved but unreadable: re-enter" or "Not set", and never puts a value back in the field or on
 * the screen. When saving is impossible (no master key, or owner sign-in not on) it says exactly what to set.
 */

type Load = { status: "loading" } | { status: "failed" } | { status: "ready"; data: SecretStatusResponse };

async function readStatus(): Promise<Load> {
  try {
    const response = await fetch("/api/settings/secrets", { cache: "no-store" });
    if (!response.ok) return { status: "failed" };
    return { status: "ready", data: (await response.json()) as SecretStatusResponse };
  } catch {
    return { status: "failed" };
  }
}

function statusText(status: SecretStatus): string {
  if (status.state === "unset") return "Not set";
  if (status.state === "unreadable") return "Saved but unreadable: re-enter";
  const when = status.updatedAt
    ? new Intl.DateTimeFormat(displayLocale(), { day: "numeric", month: "short" }).format(new Date(status.updatedAt))
    : "";
  return when ? `Saved ${when}` : "Saved";
}

function SecretRow({
  name,
  status,
  canWrite,
  canRemove,
  onChanged
}: {
  name: SecretName;
  status: SecretStatus | undefined;
  canWrite: boolean;
  canRemove: boolean;
  onChanged: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { label, help } = SECRET_LABELS[name];
  const isSet = status?.isSet ?? false;
  const inputId = `secret-${name}`;

  const call = async (method: "PUT" | "DELETE") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/settings/secrets/${encodeURIComponent(name)}`, {
        method,
        ...(method === "PUT"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) }
          : {})
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "That could not be saved. Nothing was changed.");
        return;
      }
      setValue("");
      await onChanged();
    } catch {
      setError("That could not be saved. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <p className="microcopy">{help}</p>
      <p className="microcopy" data-state={status?.state ?? "unset"}>
        {status ? statusText(status) : "Not set"}
      </p>
      <input
        id={inputId}
        type="password"
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        spellCheck={false}
        value={value}
        disabled={!canWrite || busy}
        placeholder={isSet ? "Enter a new key to replace the saved one" : "Paste the key"}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="button-row">
        <Button
          variant="primary"
          size="sm"
          disabled={!canWrite || busy || value.trim() === ""}
          onClick={() => void call("PUT")}
        >
          {isSet ? "Replace" : "Save"}
        </Button>
        {isSet ? (
          <Button variant="ghost" size="sm" disabled={!canRemove || busy} onClick={() => void call("DELETE")}>
            Remove
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SecretsSection() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const refresh = useCallback(async () => setLoad(await readStatus()), []);
  useEffect(() => {
    let cancelled = false;
    void readStatus().then((next) => {
      if (!cancelled) setLoad(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const data = load.status === "ready" ? load.data : null;
  const refusal = data ? secretsRefusalMessage(data) : "";
  return (
    <section className="more-group" id="passwords-and-keys">
      <div className="section-heading">
        <h2>Passwords and keys</h2>
      </div>
      <p className="reason">
        Keys you enter here are sealed with AES-256-GCM under a master key held only by the portal, then shown only as
        &ldquo;Saved&rdquo;: a saved key is never shown again, never sent back to this page and never readable by an AI
        agent. To change one, replace it. The JSON backup leaves keys out, so after restoring from it you enter them
        again.
      </p>
      <p className="microcopy">
        What this protects: a database dump, a backup (the database copy taken before an upgrade holds only the sealed
        text, and the master key is never in /backups) or direct SQL access sees only sealed text. What it does not:
        someone who controls the running portal (which holds the master key) or can run <code>docker inspect</code> on
        it. If the master key changes, saved keys become unreadable and must be entered again.
      </p>
      {load.status === "loading" ? <p className="microcopy">Loading…</p> : null}
      {load.status === "failed" ? (
        <p className="form-error" role="alert">
          Passwords and keys could not be read.{" "}
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            Try again
          </Button>
        </p>
      ) : null}
      {data && refusal ? (
        <p className="settings-preview" role="note">
          {refusal}
        </p>
      ) : null}
      {data
        ? SECRET_NAMES.map((name) => (
            <SecretRow
              key={name}
              name={name}
              status={data.secrets.find((secret) => secret.name === name)}
              canWrite={data.canWrite}
              canRemove={data.ownerAuthRequired}
              onChanged={refresh}
            />
          ))
        : null}
    </section>
  );
}
