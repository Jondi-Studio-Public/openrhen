"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SecretStatusResponse } from "@openrhen/contracts";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { ollamaStartHelp } from "@/features/settings/mail-understanding-help";

/**
 * Settings, Mail understanding: where the model tier of mail understanding runs. The local model (Ollama, an IP
 * address on this network or tailnet) reads the mail; the hosted model (DeepInfra) is for the few messages the local
 * one cannot, within daily caps. Plain settings fields only: the hosted key is a saved key on Passwords and keys, and
 * the Test buttons send fixed made-up text, never mail.
 */

interface Settings {
  ollamaUrl: string | null;
  t2Model: string | null;
  t3Model: string | null;
  t3DailyMessageCap: number;
  t3DailyTokenCap: number;
  backfillDays: number;
}
interface Loaded {
  settings: Settings;
  usage: { messages: number; tokens: number };
  keyState: "set" | "unreadable" | "unset" | "unknown";
}
type TestResult =
  | { ok: true; tier: "t2" | "t3"; ms: number }
  | { ok: false; tier: "t2" | "t3"; outcome: string; message: string; ms: number };
type Load = { status: "loading" } | { status: "failed" } | { status: "ready"; data: Loaded };

const DEEPINFRA_PRIVACY = "https://docs.deepinfra.com/account/data-privacy";

async function readAll(): Promise<Load> {
  try {
    const [settings, secrets] = await Promise.all([
      fetch("/api/derived-settings", { cache: "no-store" }),
      fetch("/api/settings/secrets", { cache: "no-store" }).catch(() => null)
    ]);
    if (!settings.ok) return { status: "failed" };
    const body = (await settings.json()) as { settings: Settings; usage?: Loaded["usage"] };
    let keyState: Loaded["keyState"] = "unknown";
    if (secrets?.ok) {
      const status = (await secrets.json()) as SecretStatusResponse;
      keyState = status.secrets.find((secret) => secret.name === "deepinfra_api_key")?.state ?? "unset";
    }
    return {
      status: "ready",
      data: { settings: body.settings, usage: body.usage ?? { messages: 0, tokens: 0 }, keyState }
    };
  } catch {
    return { status: "failed" };
  }
}

const spoken = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const grouped = (n: number) => n.toLocaleString("en-US");

function keyLine(state: Loaded["keyState"]) {
  if (state === "set") return "DeepInfra key: saved.";
  if (state === "unreadable") return "DeepInfra key: saved but can no longer be opened; enter it again.";
  if (state === "unset") return "DeepInfra key: not saved.";
  return "DeepInfra key: status could not be read.";
}

export function MailUnderstandingSection() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const refresh = useCallback(async () => setLoad(await readAll()), []);
  useEffect(() => {
    let cancelled = false;
    void readAll().then((next) => {
      if (!cancelled) setLoad(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const data = load.status === "ready" ? load.data : null;

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState<"t2" | "t3" | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  if (load.status === "loading") return <p className="microcopy">Loading…</p>;
  if (!data)
    return (
      <p className="form-error" role="alert">
        Mail understanding settings could not be read.{" "}
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          Try again
        </Button>
      </p>
    );

  const { settings, usage } = data;
  const held: Record<string, string> = {
    ollamaUrl: settings.ollamaUrl ?? "",
    t2Model: settings.t2Model ?? "",
    t3Model: settings.t3Model ?? "",
    t3DailyMessageCap: String(settings.t3DailyMessageCap),
    t3DailyTokenCap: String(settings.t3DailyTokenCap),
    backfillDays: String(settings.backfillDays)
  };
  const value = (field: string) => draft[field] ?? held[field]!;
  const edit = (field: string) => (event: { target: { value: string } }) => {
    setSaved(false);
    setDraft({ ...draft, [field]: event.target.value });
  };
  const changed = Object.keys(draft).filter((field) => draft[field] !== held[field]);

  async function save() {
    if (busy || changed.length === 0) return;
    setBusy(true);
    setError("");
    const numeric = new Set(["t3DailyMessageCap", "t3DailyTokenCap", "backfillDays"]);
    const patch: Record<string, string | number | null> = {};
    for (const field of changed) {
      const text = draft[field]!.trim();
      patch[field] = numeric.has(field) ? (text === "" ? Number.NaN : Number(text)) : text === "" ? null : text;
    }
    try {
      const response = await fetch("/api/derived-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "That could not be saved. Nothing was changed.");
        return;
      }
      setDraft({});
      setSaved(true);
      await refresh();
    } catch {
      setError("That could not be saved. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  async function test(tier: "t2" | "t3") {
    if (testing) return;
    setTesting(tier);
    setResult(null);
    try {
      const response = await fetch("/api/derived-settings/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier })
      });
      const payload = (await response.json().catch(() => null)) as { result?: TestResult; error?: string } | null;
      setResult(
        payload?.result ?? {
          ok: false,
          tier,
          outcome: "error",
          message: payload?.error ?? "The test could not run.",
          ms: 0
        }
      );
      await refresh();
    } catch {
      setResult({
        ok: false,
        tier,
        outcome: "error",
        message: "The test could not run. Check that the portal is up.",
        ms: 0
      });
    } finally {
      setTesting(null);
    }
  }

  const help = result && !result.ok && result.tier === "t2" ? ollamaStartHelp(settings.ollamaUrl) : null;
  return (
    <section className="more-group" id="mail-understanding">
      <div className="section-heading">
        <h2>Mail understanding</h2>
      </div>
      <p className="reason">
        A model reads your mail to find who asked what by when. Your own computer&rsquo;s model (Ollama) reads it first;
        the hosted model (DeepInfra) is only for messages the local one cannot read, within the daily limits below.
      </p>
      <div className="editor-grid settings-grid">
        <Field label="Ollama address" wide>
          <input
            id="mu-ollama-url"
            aria-label="Ollama address"
            value={value("ollamaUrl")}
            placeholder="http://192.168.1.20:11434"
            spellCheck={false}
            onChange={edit("ollamaUrl")}
          />
          <small>The IP address and port of the computer that runs Ollama, on this network or your tailnet.</small>
        </Field>
        <Field label="Local model">
          <input
            aria-label="Local model"
            value={value("t2Model")}
            placeholder="qwen3:8b"
            spellCheck={false}
            onChange={edit("t2Model")}
          />
        </Field>
        <Field label="Hosted model">
          <input
            aria-label="Hosted model"
            value={value("t3Model")}
            placeholder="Qwen/Qwen3-14B"
            spellCheck={false}
            onChange={edit("t3Model")}
          />
        </Field>
        <Field label="Hosted messages a day">
          <input
            aria-label="Hosted messages a day"
            inputMode="numeric"
            value={value("t3DailyMessageCap")}
            onChange={edit("t3DailyMessageCap")}
          />
          <small>0 stops hosted sends.</small>
        </Field>
        <Field label="Hosted tokens a day">
          <input
            aria-label="Hosted tokens a day"
            inputMode="numeric"
            value={value("t3DailyTokenCap")}
            onChange={edit("t3DailyTokenCap")}
          />
        </Field>
        <Field label="Days to look back">
          <input
            aria-label="Days to look back"
            inputMode="numeric"
            value={value("backfillDays")}
            onChange={edit("backfillDays")}
          />
          <small>How far back the model tier reads old mail.</small>
        </Field>
      </div>
      <p className="microcopy" role="status">
        Sent to the hosted model in the last 24 hours: {usage.messages} of {settings.t3DailyMessageCap} messages,{" "}
        {grouped(usage.tokens)} of {grouped(settings.t3DailyTokenCap)} tokens.
      </p>
      <p className="microcopy" data-state={data.keyState}>
        {keyLine(data.keyState)}{" "}
        {data.keyState === "set" ? null : (
          <>
            Save it under <Link href="/settings/passwords-and-keys">Passwords and keys</Link>. A restore from a backup
            empties saved keys, so enter it again afterwards.
          </>
        )}
      </p>
      <div className="button-row">
        <Button variant="primary" size="sm" disabled={busy || changed.length === 0} onClick={() => void save()}>
          Save
        </Button>
        {saved ? <span className="microcopy">Saved.</span> : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <h3>Privacy</h3>
      <p className="microcopy">
        The hosted tier is guarded by a deny-list, and a deny-list is reactive: the first mail from a new sensitive
        sender (a bank or clinic you have never had mail from, say) can reach the hosted model before that sender is
        known. Only person-to-person mail without a sign-in failure, one-time code, banking word or sender you labelled
        sensitive is eligible, and each send is counted above. If that is not acceptable, set the daily messages to 0.
      </p>
      <p className="microcopy">
        DeepInfra&rsquo;s published policy is that it does not log request content or keep it after answering, and does
        not train on it. That is how every request is handled; there is no setting to turn on, in this app or in your
        DeepInfra account. The exception is Google or Anthropic models, where that company&rsquo;s own policy applies,
        so this app refuses to send mail to them. See{" "}
        <a href={DEEPINFRA_PRIVACY} target="_blank" rel="noreferrer">
          DeepInfra data privacy
        </a>
        ; model pages marked &ldquo;Zero retention&rdquo; are the safest choice.
      </p>

      <h3>Test</h3>
      <p className="microcopy">
        Each test sends made-up text, never your mail, using the settings as last saved. A hosted test counts as one
        send.
      </p>
      <div className="button-row">
        <Button size="sm" disabled={testing !== null} onClick={() => void test("t2")}>
          Test local model
        </Button>
        <Button size="sm" disabled={testing !== null} onClick={() => void test("t3")}>
          Test hosted model
        </Button>
        {testing ? (
          <span className="microcopy">Testing… a model that is still loading can take a few minutes.</span>
        ) : null}
      </div>
      {result ? (
        result.ok ? (
          <p className="settings-preview" role="status">
            {result.tier === "t2" ? "Local" : "Hosted"} model answered in {spoken(result.ms)}.
          </p>
        ) : (
          <p className="form-error" role="alert">
            {result.tier === "t2" ? "Local" : "Hosted"} model test failed: {result.message}
          </p>
        )
      ) : null}
      {help ? (
        <div className="settings-preview">
          <p>
            If Ollama is running but cannot be reached from here, it is probably listening only on its own computer. In
            PowerShell on the Ollama computer run:
          </p>
          <pre>
            <code>{help.lines.join("\n")}</code>
          </pre>
          <ol>
            {help.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
