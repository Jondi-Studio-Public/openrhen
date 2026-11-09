"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { PlanningRuntimeState } from "@openrhen/contracts";
import { Sheet } from "@/components/sheet";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { PageHeader } from "@/components/ui/page-header";
import {
  DetailChips,
  DetailCode,
  DetailDivider,
  DetailMetrics,
  DetailStack,
  DetailSubheading
} from "@/components/connection-detail";
import { DataFlowCountsLink } from "@/features/data-flow/components/data-flow-counts";
import { DatabaseStatus } from "@/components/database-status";
import { useNow } from "@/shared/clock";
import { formatConnectionDateTime } from "@/shared/connection-date-time";
import { connectionExtensions } from "@/features/connections/connection-extensions";
import { engineConnectionView } from "@/features/planning/engine-connection";
import { GoogleCalendarCard } from "@/features/calendar-sync/components/google-calendar-card";
import {
  CONNECTION_IDS,
  PROVIDER_ROWS,
  connectionsAnswer,
  deriveConnectionSummaries,
  type ConnectionState
} from "@/features/connections/connection-summaries";
import {
  useConnectionData,
  type ProviderName,
  type ProviderStatusView
} from "@/features/connections/use-connection-data";
import styles from "./connections.module.css";

type Data = ReturnType<typeof useConnectionData>;
type FormatDateTime = (value: string | undefined) => string;

const STATE_BADGE: Record<ConnectionState, { label: string; tone: BadgeTone }> = {
  on: { label: "On", tone: "accent" },
  setup: { label: "Setup", tone: "warn" },
  off: { label: "Off", tone: "danger" },
  checking: { label: "Checking", tone: "neutral" },
  behind: { label: "Behind", tone: "warn" },
  unknown: { label: "Not run", tone: "neutral" }
};

/** An optional integration nobody has set up is a choice, not a warning. */
const OPTIONAL_BADGE: { label: string; tone: BadgeTone } = { label: "Optional", tone: "neutral" };

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 5_000) return "just now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function reachabilityTone(status: ProviderStatusView | undefined): BadgeTone {
  if (!status || status.source === "skipped" || status.reachable === null) return "warn";
  return status.reachable ? "accent" : "danger";
}

function reachabilityLabel(status: ProviderStatusView | undefined): string {
  if (!status) return "Checking…";
  // Google only: an active check found no located, upcoming commitment worth refreshing, so no
  // request was made and reachability is genuinely unknown rather than failed.
  if (status.source === "skipped") return "No recent traffic, nothing to refresh";
  if (status.reachable === null) return "Checking…";
  const via = status.source === "real_call" ? "via a real call" : "via a probe";
  return status.reachable
    ? `Reachable — ok, ${timeAgo(status.checkedAt)} ${via}`
    : `Unreachable — failed ${timeAgo(status.checkedAt)} ${via}`;
}

/**
 * The metrics common to every provider: reachability with freshness, latency averaged over the last
 * 24h (time-to-first-token for streaming calls, total response time otherwise), the most recent call,
 * token usage when the provider supplied it, and a per-call-type breakdown for the same window.
 */
function ProviderTelemetryBlock({
  status,
  checking,
  onCheckNow
}: {
  status: ProviderStatusView | undefined;
  checking: boolean;
  onCheckNow: () => void;
}) {
  const checkButton = (
    <Button size="sm" disabled={checking} onClick={onCheckNow}>
      {checking ? "Checking…" : "Check now"}
    </Button>
  );
  // Not set up is a state, not a failure: one neutral line, no red chip, no empty-metrics noise.
  if (status?.source === "not_configured") {
    return (
      <div className={styles.telemetry}>
        <DetailSubheading title={<Badge tone="neutral">Not set up yet</Badge>}>{checkButton}</DetailSubheading>
        {/* The probe's own detail names what is missing, whichever provider or sidecar it is. */}
        <p className="microcopy">
          {status.detail ?? "Its settings are not added yet."} Once it is set up, check again.
        </p>
      </div>
    );
  }
  const metrics = [];
  if (status && status.firstByteSampleCount > 0)
    metrics.push({
      value: `${status.avgFirstByteMs} ms`,
      label: `avg time-to-first-token · 24h · ${status.firstByteSampleCount} calls`
    });
  if (status && status.totalSampleCount > 0)
    metrics.push({
      value: `${status.avgTotalMs} ms`,
      label: `avg response time · 24h · ${status.totalSampleCount} calls`
    });
  if (status && (status.inputTokens24h !== null || status.outputTokens24h !== null))
    metrics.push({
      value: `${(status.inputTokens24h ?? 0).toLocaleString()} / ${(status.outputTokens24h ?? 0).toLocaleString()}`,
      label: "tokens in / out · 24h"
    });
  return (
    <div className={styles.telemetry}>
      <DetailSubheading title={<Badge tone={reachabilityTone(status)}>{reachabilityLabel(status)}</Badge>}>
        {checkButton}
      </DetailSubheading>
      {status?.detail && <p className="microcopy">{status.detail}</p>}
      {status?.rateLimited && (
        <p className="microcopy">Reused a recent check — probes are limited to about once every 5 minutes.</p>
      )}
      {metrics.length > 0 ? (
        <DetailMetrics items={metrics} />
      ) : (
        <p className="empty">No calls recorded in the last 24h.</p>
      )}
      <p className="microcopy">
        Last call:{" "}
        {status?.lastCallAt
          ? `${status.lastCallOperation} · ${status.lastCallOk ? "ok" : "failed"} · ${timeAgo(status.lastCallAt)}`
          : "none recorded"}
      </p>
      {status && status.callCountsByOperation.length > 0 && (
        <DetailChips
          label="Calls by type · 24h"
          items={status.callCountsByOperation.map((item) => `${item.operation}: ${item.count}`)}
        />
      )}
    </div>
  );
}

function PlannerDetail({
  data,
  planning,
  ready,
  formatDateTime
}: {
  data: Data;
  planning: PlanningRuntimeState | undefined;
  ready: boolean;
  formatDateTime: FormatDateTime;
}) {
  const { probing, probeEngine } = data;
  const probe = data.inputs.probe;
  const engine = engineConnectionView(planning, ready);
  const engineResult = planning?.result;
  const engineTone: BadgeTone = engine.tone === "connected" ? "accent" : engine.tone === "failed" ? "danger" : "warn";
  return (
    <DetailStack>
      <DetailSubheading title="Planning service">
        <Button size="sm" disabled={probing} onClick={() => void probeEngine()}>
          {probing ? "Checking…" : "Test again"}
        </Button>
      </DetailSubheading>
      <div>
        <Badge tone={engineTone}>{engine.label}</Badge>
      </div>
      <p>{engine.summary}</p>
      {probe.state === "loading" && <p className="empty">Checking whether the engine service is answering…</p>}
      {probe.state === "reachable" && (
        <p className="microcopy">
          Service reachable: answered <strong>{probe.status}</strong> in {probe.latencyMs} ms (engine{" "}
          {probe.engineVersion ?? "—"}, contract {probe.contractVersion ?? "—"}).
        </p>
      )}
      {probe.state === "unreachable" && (
        <>
          <div>
            <Badge tone={probe.configured ? "danger" : "warn"}>
              {probe.configured ? "Service unreachable" : "Needs a setting on the server"}
            </Badge>
          </div>
          <p>{probe.detail}</p>
          <p className="microcopy">
            {probe.configured
              ? "Queued planning work will resume automatically once the service answers again."
              : "Add the planning service address to the server's settings to enable this check."}
          </p>
          {!probe.configured && <DetailCode>PLAN_FORECAST_SERVICE_URL</DetailCode>}
        </>
      )}
      <DetailMetrics
        items={[
          { value: engineResult?.engineVersion ?? "—", label: "engine version" },
          { value: engineResult?.contractVersion ?? "—", label: "contract version" },
          { value: planning?.status ?? "unknown", label: "runtime state" }
        ]}
      />
      <DetailMetrics
        items={[
          {
            value: formatDateTime(planning?.lastSuccessfulAt ?? engineResult?.calculatedAt),
            label: "Last successful calculation"
          },
          { value: formatDateTime(planning?.validUntil ?? engineResult?.validUntil), label: "Valid until" },
          ...(planning?.nextAttemptAt ? [{ value: formatDateTime(planning.nextAttemptAt), label: "Next attempt" }] : [])
        ]}
      />
      {planning?.message ? <p className="microcopy">Engine detail: {planning.message}</p> : null}
    </DetailStack>
  );
}

function ProviderDetail({ data, provider, about }: { data: Data; provider: ProviderName; about: string }) {
  return (
    <DetailStack>
      <p className="microcopy">{about}</p>
      <ProviderTelemetryBlock
        status={data.inputs.providers[provider]}
        checking={data.checkingProvider === provider}
        onCheckNow={() => void data.checkProviderNow(provider)}
      />
    </DetailStack>
  );
}

const isConnectionId = (value: string): boolean =>
  (CONNECTION_IDS as readonly string[]).includes(value) ||
  connectionExtensions().some((extension) => extension.id === value);

export default function ConnectionsPage() {
  const data = useConnectionData();
  const { inputs } = data;
  const [openId, setOpenId] = useState<string | null>(null);
  // The sheet keeps showing the last connection while it slides away.
  const [shownId, setShownId] = useState<string | null>(null);
  const select = useCallback((id: string | null) => {
    setOpenId(id);
    if (id) setShownId(id);
  }, []);

  // /connections#<id> opens that row's details, so the You page can link straight to one.
  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.slice(1);
      select(isConnectionId(id) ? id : null);
    };
    // oxlint-disable-next-line react/set-state-in-effect -- reads the address once on arrival
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [select]);
  const open = useCallback(
    (id: string) => {
      window.history.replaceState(null, "", `#${id}`);
      select(id);
    },
    [select]
  );
  const close = useCallback(() => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    select(null);
  }, [select]);

  const summaries = deriveConnectionSummaries(inputs, useNow("minute"));
  const formatDateTime: FormatDateTime = (value) =>
    value ? formatConnectionDateTime(value, inputs.timezone) : "Not available";
  const providerStatus = (provider: ProviderName) => inputs.providers[provider];
  const shown = summaries.find((summary) => summary.id === shownId);

  let details: ReactNode = null;
  switch (shownId) {
    case "planner":
      details = (
        <PlannerDetail data={data} planning={inputs.planning} ready={inputs.ready} formatDateTime={formatDateTime} />
      );
      break;
    case "google-calendar":
      details = (
        <GoogleCalendarCard onChecked={data.reloadGoogle}>
          {providerStatus("google_calendar")?.source !== "not_configured" && (
            <ProviderTelemetryBlock
              status={providerStatus("google_calendar")}
              checking={data.checkingProvider === "google_calendar"}
              onCheckNow={() => void data.checkProviderNow("google_calendar")}
            />
          )}
        </GoogleCalendarCard>
      );
      break;
  }
  const providerRow = PROVIDER_ROWS.find((row) => row.id === shownId);
  if (providerRow) details = <ProviderDetail data={data} provider={providerRow.provider} about={providerRow.about} />;

  const extension = connectionExtensions().find((candidate) => candidate.id === shownId);
  if (extension && shownId) {
    const status = extension.provider ? providerStatus(extension.provider) : undefined;
    const telemetry =
      extension.provider && status?.source !== "not_configured" ? (
        <>
          <DetailDivider />
          <ProviderTelemetryBlock
            status={status}
            checking={data.checkingProvider === extension.provider}
            onCheckNow={() => void data.checkProviderNow(extension.provider as ProviderName)}
          />
        </>
      ) : null;
    details = (
      <extension.Detail read={inputs.extensions[shownId]} formatDateTime={formatDateTime} telemetry={telemetry} />
    );
  }

  return (
    <main className={`content-page ${styles.page}`}>
      <PageHeader title="Connections" answer={connectionsAnswer(summaries)} actions={<DataFlowCountsLink />} />
      <DatabaseStatus />
      <Card className={styles.list}>
        <List>
          {summaries.map((summary) => {
            const badge = summary.optional ? OPTIONAL_BADGE : STATE_BADGE[summary.state];
            return (
              <ListRow
                key={summary.id}
                title={summary.title}
                meta={summary.meta}
                trailing={<Badge tone={badge.tone}>{badge.label}</Badge>}
                onClick={() => open(summary.id)}
              />
            );
          })}
        </List>
      </Card>
      <p className={styles.caption}>Each row opens its details: versions, last run and what to do if it stops.</p>
      <Sheet open={openId !== null} onClose={close} title={shown?.title ?? "Connection"}>
        {details}
      </Sheet>
    </main>
  );
}
