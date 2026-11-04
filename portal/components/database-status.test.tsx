// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import { DatabaseStatus } from "@/components/database-status";

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );
}

describe("DatabaseStatus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the database connected", async () => {
    respond(200, { provider: "postgresql", connected: true, version: "PostgreSQL 16, x", latencyMs: 4 });
    render(<DatabaseStatus />);
    expect(await screen.findByText("PostgreSQL connected")).toBeTruthy();
  });

  it("says migrations are pending, not that the connection is down", async () => {
    respond(503, {
      connected: true,
      provider: "postgresql",
      version: "Unavailable",
      latencyMs: 0,
      errorCode: "MIGRATIONS_PENDING",
      detail: "1 database migration is pending (0103_x); run db:migrate"
    });
    render(<DatabaseStatus />);
    expect(await screen.findByText("Migrations pending")).toBeTruthy();
    expect(screen.getByText(/0103_x/)).toBeTruthy();
    expect(screen.queryByText("Connection unavailable")).toBeNull();
  });

  it("shows the connection unavailable when the answer has no version to show", async () => {
    respond(200, {});
    render(<DatabaseStatus />);
    expect(await screen.findByText("Connection unavailable")).toBeTruthy();
  });

  it("shows the connection unavailable for any other failure", async () => {
    respond(503, { connected: false, errorCode: "ECONNREFUSED" });
    render(<DatabaseStatus />);
    expect(await screen.findByText("Connection unavailable")).toBeTruthy();
  });
});
