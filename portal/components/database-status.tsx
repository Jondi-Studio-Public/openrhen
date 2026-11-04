"use client";

import { useEffect, useState } from "react";

interface Health {
  provider: string;
  connected: boolean;
  version: string;
  latencyMs: number;
  errorCode?: string;
  detail?: string;
}

export function DatabaseStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health/database")
      .then(async (response) => {
        const body = (await response.json()) as Health;
        if (!response.ok) {
          if (body.errorCode === "MIGRATIONS_PENDING") {
            setPending(body.detail ?? "Database migrations are pending.");
            return;
          }
          throw new Error("Database unavailable");
        }
        if (typeof body.version !== "string") throw new Error("Database answer unreadable");
        setHealth(body);
      })
      .catch(() => setFailed(true));
  }, []);

  if (pending)
    return (
      <div className="database-status error">
        <span>Database</span>
        <strong>Migrations pending</strong>
        <small>{pending}</small>
      </div>
    );
  if (failed)
    return (
      <div className="database-status error">
        <span>Database</span>
        <strong>Connection unavailable</strong>
      </div>
    );
  if (!health)
    return (
      <div className="database-status">
        <span>Database</span>
        <strong>Checking…</strong>
      </div>
    );

  return (
    <div className="database-status connected">
      <span>Database</span>
      <strong>PostgreSQL connected</strong>
      <small>
        {health.version.split(",")[0]} · {health.latencyMs} ms
      </small>
    </div>
  );
}
