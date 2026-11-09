"use client";

import { useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { PageHeader } from "@/components/ui/page-header";
import { SearchIcon } from "@/components/icons";
import { Sheet } from "@/components/sheet";
import {
  connectionsAnswer,
  useRecordedConnectionSummaries,
  type ConnectionState,
  type ConnectionSummary
} from "@/features/connections/connection-summaries";
import { PulseBadge } from "@/features/pulse/components/pulse-badge";
import { pulseSentence } from "@/features/pulse/pulse-view";
import { usePortal } from "@/state/portal-provider";
import { SettingsRows } from "@/features/settings/components/settings-rows";
import { DataFlowCountsLink } from "@/features/data-flow/components/data-flow-counts";
import { useDoctorReport } from "@/features/doctor/doctor-client";
import { attentionCount } from "@/features/doctor/doctor-model";
import { hoursLabel, useYouOverview, type YouOverview } from "@/features/you/use-you-overview";
import { YouSection } from "@/app/you/you-section";
import { extensionYouPhoneRows, extensionYouSections } from "@/state/extensions";
import { openGoTo } from "@/shared/use-go-to";
import styles from "./you.module.css";

const badge: Record<ConnectionState, { tone: BadgeTone; label: string }> = {
  on: { tone: "accent", label: "On" },
  setup: { tone: "warn", label: "Setup" },
  off: { tone: "danger", label: "Off" },
  behind: { tone: "warn", label: "Behind" },
  checking: { tone: "neutral", label: "Checking" },
  unknown: { tone: "neutral", label: "Not run" }
};

/** An optional integration nobody has set up is a choice, not a warning. */
const optionalBadge: { tone: BadgeTone; label: string } = { tone: "neutral", label: "Optional" };

function recordRows(overview: YouOverview) {
  const sleep =
    overview.lastNightMinutes === undefined
      ? "The nights you have logged"
      : overview.lastNightMinutes === null
        ? "No night logged yet"
        : `Last night ${hoursLabel(overview.lastNightMinutes)}`;
  const photos =
    overview.photoCount === undefined
      ? "Photos sent from the phone"
      : overview.photoCount === 0
        ? "None yet"
        : `${overview.photoCount} sent`;
  const reports =
    overview.openReports === undefined
      ? "Problems you flagged, with a snapshot"
      : overview.openReports === 0
        ? "Nothing open"
        : `${overview.openReports} to look at`;
  return [
    { href: "/history", title: "History", meta: "Sessions and finished commitments" },
    { href: "/sleep", title: "Sleep log", meta: sleep },
    { href: "/photo-checkins", title: "Photo check-ins", meta: photos },
    { href: "/reports", title: "Reported issues", meta: reports }
  ];
}

function ConnectionRows({ summaries }: { summaries: readonly ConnectionSummary[] }) {
  return (
    <List>
      {summaries.map((summary) => (
        <ListRow
          key={summary.id}
          href={`/connections#${summary.id}`}
          leading={
            <Badge tone={(summary.optional ? optionalBadge : badge[summary.state]).tone}>
              {(summary.optional ? optionalBadge : badge[summary.state]).label}
            </Badge>
          }
          title={summary.title}
          meta={summary.meta}
          className={styles.connection ?? ""}
        />
      ))}
    </List>
  );
}

function connectionsLine(summaries: readonly ConnectionSummary[]): string {
  const on = summaries.filter((summary) => summary.state === "on").length;
  const setup = summaries.filter((summary) => summary.state === "setup" && !summary.optional).length;
  const off = summaries.filter((summary) => summary.state === "off").length;
  return [`${on} on`, setup ? `${setup} needs setup` : "", off ? `${off} not working` : ""].filter(Boolean).join(" · ");
}

/**
 * Everything that is about you rather than today's work: what has been recorded, who else is in it,
 * what it is connected to, and how it is set up. On a desk the four groups sit side by side; a phone
 * folds Records, People and Connections into one row each (Records opens a sheet) and lists Settings.
 */
export default function YouPage() {
  const overview = useYouOverview();
  const summaries = useRecordedConnectionSummaries();
  const [recordsOpen, setRecordsOpen] = useState(false);
  const doctor = useDoctorReport();
  const dataCheckMeta = !doctor
    ? "What in your plan is out of date or missing"
    : doctor.healthy
      ? "Healthy"
      : attentionCount(doctor) > 0
        ? `${attentionCount(doctor)} to fix`
        : `${doctor.counts.tidy} to tidy`;
  const { state } = usePortal();
  const records = recordRows(overview);
  const recordList = (
    <List>
      {records.map((row) => (
        <ListRow key={row.href} href={row.href} title={row.title} meta={row.meta} />
      ))}
    </List>
  );

  return (
    <main className={`content-page ${styles.page}`}>
      <PageHeader title="You" answer={connectionsAnswer(summaries)} actions={<DataFlowCountsLink />} />
      {state.pulse && (
        <Card>
          <List>
            <ListRow
              href="/settings/pulse"
              leading={<PulseBadge pulse={state.pulse} />}
              title="Pulse"
              meta={pulseSentence(state.pulse)}
            />
          </List>
        </Card>
      )}

      <div className={styles.grid}>
        <div className={styles.phone}>
          <Card>
            <List>
              <ListRow leading={<SearchIcon />} title="Go to a page or setting" onClick={openGoTo} />
            </List>
          </Card>
          <Card>
            <List>
              <ListRow title="Records" meta="History, sleep log, photos, issues" onClick={() => setRecordsOpen(true)} />
              {extensionYouPhoneRows().map((PhoneRow, index) => (
                <PhoneRow key={index} />
              ))}
              <ListRow
                href="/connections"
                title="Connections"
                meta={summaries.length ? connectionsLine(summaries) : ""}
              />
              <ListRow href="/doctor" title="Data check" meta={dataCheckMeta} />
              <ListRow
                href="/data"
                title="Data"
                meta="Where each data point comes from, where it goes and what it gives"
              />
            </List>
          </Card>
          <Sheet open={recordsOpen} onClose={() => setRecordsOpen(false)} title="Records">
            {recordList}
          </Sheet>
        </div>
        <div className={`${styles.column} ${styles.desk}`}>
          <YouSection id="records" label="Records">
            <Card>{recordList}</Card>
          </YouSection>
          <YouSection id="data-check" label="Data check">
            <Card>
              <List>
                <ListRow href="/doctor" title="Data check" meta={dataCheckMeta} />
                <ListRow
                  href="/data"
                  title="Data"
                  meta="Where each data point comes from, where it goes and what it gives"
                />
              </List>
            </Card>
          </YouSection>
          {extensionYouSections().map((ExtensionSection, index) => (
            <ExtensionSection key={index} />
          ))}
        </div>
        <div className={styles.desk}>
          <YouSection id="connections" label="Connections">
            <Card>
              <ConnectionRows summaries={summaries} />
            </Card>
            <p className={styles.caption}>From each connection's last run. Open a row to check it now.</p>
          </YouSection>
        </div>
        <YouSection id="settings" label="Settings">
          <SettingsRows />
        </YouSection>
      </div>
    </main>
  );
}
