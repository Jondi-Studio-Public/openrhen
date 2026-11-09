import Link from "next/link";
import type { DoctorReport } from "@openrhen/contracts";

/**
 * The data-source counts under the Data check and Connections headings ("4 late · 1 device silent · 11 collected,
 * unused"), with the link to the Data page. It draws nothing when the report carries no counts or every count is zero,
 * so a healthy install shows no extra line.
 */
export function SourcesCountsLine({
  report,
  className
}: {
  report: Pick<DoctorReport, "sources"> | null;
  className?: string | undefined;
}) {
  const line = report?.sources?.line;
  if (!line) return null;
  return (
    <p className={className} data-sources-counts>
      {line} · <Link href="/data">See the Data page</Link>
    </p>
  );
}
