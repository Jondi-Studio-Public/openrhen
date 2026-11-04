"use client";

import { useEffect, useState } from "react";
import type { DoctorReport } from "@openrhen/contracts";
import { parseDoctorReport } from "./doctor-model";

/** Reads the data check; throws when the server or the body is not a report. */
export async function fetchDoctor(): Promise<DoctorReport> {
  const response = await fetch("/api/doctor", { cache: "no-store" });
  if (!response.ok) throw new Error("The data check could not be read.");
  const report = parseDoctorReport(await response.json());
  if (!report) throw new Error("The data check could not be read.");
  return report;
}

const REUSE_MS = 30_000;
let recent: { at: number; report: Promise<DoctorReport> } | null = null;

/** One read shared by the You and Review count lines when both mount within a short time. */
function fetchDoctorShared(): Promise<DoctorReport> {
  if (recent && Date.now() - recent.at < REUSE_MS) return recent.report;
  const report = fetchDoctor();
  recent = { at: Date.now(), report };
  report.catch(() => {
    if (recent?.report === report) recent = null;
  });
  return report;
}

/** The report for a count line on You or Review; null while loading or if it cannot be read (the Data check page shows the error). */
export function useDoctorReport(): DoctorReport | null {
  const [report, setReport] = useState<DoctorReport | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchDoctorShared()
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return report;
}
