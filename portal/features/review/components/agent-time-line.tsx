"use client";

import { useEffect, useState } from "react";
import { agentTimeLine, type AgentTimeSummary } from "@openrhen/contracts";

/**
 * One line of agent time for the weekly review. Information only: it reads
 * `/api/agent-sessions`, shows nothing while loading or when the read fails, and feeds nothing back into the plan.
 */
export function AgentTimeLine() {
  const [summary, setSummary] = useState<AgentTimeSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent-sessions?days=7")
      .then((response) => (response.ok ? (response.json() as Promise<AgentTimeSummary>) : null))
      .then((payload) => {
        if (!cancelled && payload) setSummary(payload);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return summary ? <p className="microcopy agent-time-line">{agentTimeLine(summary)}</p> : null;
}
