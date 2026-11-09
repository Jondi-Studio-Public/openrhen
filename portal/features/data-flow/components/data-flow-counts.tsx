"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useNow } from "@/shared/clock";
import { buildFlowModel, countsLine } from "../data-flow-model";
import { useDataFlow } from "../use-data-flow";
import styles from "./data-flow.module.css";

/**
 * The counts line ("4 late · 1 device silent · 11 collected, unused") as a link to /data, for the Connections and You
 * headers. One read on mount, no polling; nothing is shown while loading or when the map cannot be read.
 */
export function DataFlowCountsLink() {
  const { data } = useDataFlow({ poll: false });
  const now = useNow("minute");
  const line = useMemo(() => (data ? countsLine(buildFlowModel(data, { now })) : null), [data, now]);
  if (!line) return null;
  return (
    <Link className={styles.countsLink} href="/data">
      {line}
    </Link>
  );
}
