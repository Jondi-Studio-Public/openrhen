"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DoctorArea, DoctorItem, DoctorReport } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { useNow } from "@/shared/clock";
import { fetchDoctor } from "../doctor-client";
import { SourcesCountsLine } from "./sources-counts-line";
import { areaLabel, areasPresent, groupByTier, handleLink, sinceText, summaryLine } from "../doctor-model";

function Row({ item, now, plan }: { item: DoctorItem; now: Date; plan: Parameters<typeof handleLink>[1] }) {
  const age = sinceText(item.since, now);
  const links = item.handles.map((handle) => handleLink(handle, plan)).filter((link) => link !== null);
  return (
    <li className="doctor-item">
      <h3>{item.title}</h3>
      <p className="doctor-why">{item.why}</p>
      {age && <p className="doctor-age">{age}</p>}
      {item.fix.who === "person" ? (
        item.fix.question && <p className="doctor-question">{item.fix.question}</p>
      ) : (
        <div className="doctor-agent">
          <p>An agent can fix this</p>
          {item.fix.next && <p className="doctor-question">{item.fix.next}</p>}
          {item.fix.cli && <code>{item.fix.cli}</code>}
        </div>
      )}
      {links.map((link) => (
        <a key={link.href} className="doctor-link" href={link.href}>
          {link.label}
        </a>
      ))}
    </li>
  );
}

/**
 * `/doctor`, "Data check": what in the plan's data is out of date or missing, worst first, grouped
 * Blocking, Degrading and Tidy. Read-only: an agent fixes an item, or
 * you do on the item's own page. An empty tier is not drawn.
 */
export function DoctorPage() {
  const { state } = usePortal();
  const now = useNow("minute");
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loadError, setLoadError] = useState("");
  const [area, setArea] = useState<DoctorArea | null>(null);
  const [reads, setReads] = useState(0);
  const retry = useCallback(() => {
    setLoadError("");
    setReads((count) => count + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchDoctor()
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch(() => {
        if (!cancelled) setLoadError("The data check could not be loaded. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [reads]);

  const items = useMemo(() => report?.items ?? [], [report]);
  const areas = useMemo(() => areasPresent(items), [items]);
  const groups = useMemo(() => groupByTier(items, area), [items, area]);
  const plan = { projects: state.projects, outcomes: state.outcomes, areas: state.areas };

  if (loadError)
    return (
      <section className="doctor" role="alert">
        <p>{loadError}</p>
        <button type="button" className="secondary" onClick={retry}>
          Try again
        </button>
      </section>
    );
  if (!report) return <p className="muted">Checking your data…</p>;

  return (
    <section className="doctor">
      <p className="doctor-summary" role="status">
        {summaryLine(report)}
      </p>
      <SourcesCountsLine report={report} className="doctor-sources" />
      {report.notChecked.length > 0 && (
        <ul className="doctor-not-checked">
          {report.notChecked.map((entry) => (
            <li key={entry.check}>
              Not checked: {entry.check.replace(/_/g, " ")}. {entry.reason}
            </li>
          ))}
        </ul>
      )}
      {areas.length > 1 && (
        <div className="doctor-chips" role="group" aria-label="Filter by area">
          <button
            type="button"
            className={area === null ? "selected" : "quiet"}
            aria-pressed={area === null}
            onClick={() => setArea(null)}
          >
            All
          </button>
          {areas.map((name) => (
            <button
              key={name}
              type="button"
              className={area === name ? "selected" : "quiet"}
              aria-pressed={area === name}
              onClick={() => setArea(area === name ? null : name)}
            >
              {areaLabel(name)}
            </button>
          ))}
        </div>
      )}
      {groups.map((group) => (
        <section key={group.tier} className="doctor-tier" data-tier={group.tier} aria-label={group.label}>
          <h2>
            {group.label} <span className="doctor-count">{group.items.length}</span>
          </h2>
          <ul>
            {group.items.map((item) => (
              <Row key={item.id} item={item} now={now} plan={plan} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
