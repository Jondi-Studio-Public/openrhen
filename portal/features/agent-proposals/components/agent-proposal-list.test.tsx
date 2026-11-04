// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProposal } from "@openrhen/contracts";
import { fireEvent, render, screen } from "@/test/render";
import { freezeClock } from "@/shared/clock";
import { AgentProposalCard, AgentProposalList } from "./agent-proposal-list";

// Fixed instant: the cards word dates and ages against the shared clock, so a moving clock ages the tests out.
const NOW = new Date("2026-11-03T00:00:00.000Z");
beforeEach(() => {
  freezeClock(NOW);
});

const proposal = (overrides: Partial<AgentProposal> = {}): AgentProposal => ({
  id: "11111111-1111-4111-8111-111111111111",
  agent: "scribe",
  kind: "entity_command",
  summary: "Move the dentist to Friday",
  payload: {},
  basis: "stated",
  evidence: "can we do Friday instead",
  targetVersions: {},
  status: "pending",
  coalesceKey: null,
  revision: 1,
  createdAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
  updatedAt: NOW.toISOString(),
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  ...overrides
});

describe("AgentProposalList", () => {
  it("shows the agent, basis, evidence quote and age, with the count", () => {
    render(<AgentProposalList proposals={[proposal()]} onResolve={async () => ({ ok: true })} />);
    const heading = screen.getByRole("heading", { name: "From agents" });
    expect(heading.parentElement!.textContent).toContain("1");
    expect(screen.getByText("Move the dentist to Friday")).toBeTruthy();
    expect(screen.getByText("Agent's evidence: can we do Friday instead")).toBeTruthy();
    expect(screen.getByText(/Scribe · stated · 3 h ago/)).toBeTruthy();
  });

  it("ties each button to the change it acts on", () => {
    render(<AgentProposalList proposals={[proposal()]} onResolve={async () => ({ ok: true })} />);
    for (const name of ["Confirm", "Reject"]) {
      const describedBy = screen.getByRole("button", { name }).getAttribute("aria-describedby");
      expect(document.getElementById(describedBy ?? "")?.textContent, name).toBe("Move the dentist to Friday");
    }
  });

  it("writes the agent in sentence case and the basis with spaces", () => {
    render(
      <AgentProposalList
        proposals={[proposal({ agent: "mail_scribe", basis: "inferred_from_history" as AgentProposal["basis"] })]}
        onResolve={async () => ({ ok: true })}
      />
    );
    expect(screen.getByText(/Mail scribe · inferred from history · 3 h ago/)).toBeTruthy();
  });

  it("renders nothing when no agent has proposed anything", () => {
    const { container } = render(<AgentProposalList proposals={[]} onResolve={async () => ({ ok: true })} />);
    expect(container.textContent).toBe("");
  });

  it.each([
    ["Confirm", "confirm"],
    ["Reject", "reject"]
  ] as const)("%s sends the %s decision through onResolve", async (label, decision) => {
    const onResolve = vi.fn(async () => ({ ok: true }) as const);
    render(<AgentProposalList proposals={[proposal()]} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", decision, 1));
  });

  it("sends one decision when Confirm is clicked twice in the same tick", async () => {
    let finish: (value: { ok: true }) => void = () => {};
    const onResolve = vi.fn(() => new Promise<{ ok: true }>((resolve) => (finish = resolve)));
    render(<AgentProposalList proposals={[proposal()]} onResolve={onResolve} />);
    const confirm = screen.getByRole("button", { name: "Confirm" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onResolve).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    await vi.waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  });

  const stale = () =>
    vi.fn(async () => ({
      ok: false as const,
      stale: true,
      message: "The record changed after the agent proposed this, so nothing was applied.",
      conflicts: [{ entity: "project:p1", proposedAgainst: 1, current: 2 }]
    }));

  it("says what moved when a confirm comes back stale, and applies nothing locally", async () => {
    render(<AgentProposalList proposals={[proposal()]} onResolve={stale()} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This changed since the agent asked. Ask it again.");
    expect(alert.textContent).toContain("project p1 is now version 2; the agent saw 1.");
  });

  it("keeps a stale card with its message and only a Dismiss, once the refreshed list holds it as stale", async () => {
    const onResolve = stale();
    const { rerender } = render(<AgentProposalList proposals={[proposal()]} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByRole("alert");
    // The portal settled the proposal as stale; the store keeps it listed with that status until dismissed.
    rerender(<AgentProposalList proposals={[proposal({ status: "stale" })]} onResolve={onResolve} />);
    expect(screen.getByText("Move the dentist to Friday")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("This changed since the agent asked. Ask it again.");
    expect(screen.getByRole("alert").textContent).toContain("project p1 is now version 2; the agent saw 1.");
    // Nothing is left to confirm or reject; the person can only clear the card.
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("says why a stale card is there even when it was found stale elsewhere", () => {
    render(
      <AgentProposalCard embedded proposal={proposal({ status: "stale" })} onResolve={async () => ({ ok: true })} />
    );
    expect(screen.getByRole("alert").textContent).toBe("This changed since the agent asked. Ask it again.");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("shows the portal's own message for any other refusal", async () => {
    const onResolve = vi.fn(async () => ({
      ok: false as const,
      stale: false,
      message: "Unknown kind.",
      conflicts: []
    }));
    render(<AgentProposalList proposals={[proposal()]} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Unknown kind.");
  });
});

describe("AgentProposalCard", () => {
  it("shows the summary in its own card by default", () => {
    render(<AgentProposalCard proposal={proposal()} onResolve={async () => ({ ok: true })} />);
    expect(screen.getByText("Move the dentist to Friday")).toBeTruthy();
    expect(screen.getByText(/Scribe · stated · 3 h ago/)).toBeTruthy();
  });

  it("drops its card edge when embedded and keeps it otherwise", () => {
    const standalone = render(<AgentProposalCard proposal={proposal()} onResolve={async () => ({ ok: true })} />);
    expect(standalone.container.querySelector("article")!.className).toBe("review-card");
    standalone.unmount();
    const flat = render(<AgentProposalCard embedded proposal={proposal()} onResolve={async () => ({ ok: true })} />);
    expect(flat.container.querySelector("article")!.className).not.toContain("review-card");
  });

  it("hides the summary when embedded, keeping the quote, the source line and the actions", () => {
    render(<AgentProposalCard embedded proposal={proposal()} onResolve={async () => ({ ok: true })} />);
    expect(screen.queryByText("Move the dentist to Friday")).toBeNull();
    expect(screen.getByText("Agent's evidence: can we do Friday instead")).toBeTruthy();
    expect(screen.getByText(/Scribe · stated · 3 h ago/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm" }).getAttribute("data-inbox-action")).toBe("yes");
    expect(screen.getByRole("button", { name: "Reject" }).getAttribute("data-inbox-action")).toBe("no");
  });

  it.each([
    ["Confirm", "confirm"],
    ["Reject", "reject"]
  ] as const)("%s sends the %s decision for its proposal", async (label, decision) => {
    const onResolve = vi.fn(async () => ({ ok: true }) as const);
    render(<AgentProposalCard embedded proposal={proposal()} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", decision, 1));
  });

  it("says what moved on a stale confirm and keeps the buttons usable", async () => {
    const onResolve = vi.fn(async () => ({
      ok: false as const,
      stale: true,
      message: "changed",
      conflicts: [{ entity: "project:p1", proposedAgainst: 1, current: 2 }]
    }));
    render(<AgentProposalCard embedded proposal={proposal()} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("project p1 is now version 2; the agent saw 1.");
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables both buttons while the decision is in flight", async () => {
    let finish: (value: { ok: true }) => void = () => {};
    const onResolve = vi.fn(() => new Promise<{ ok: true }>((resolve) => (finish = resolve)));
    render(<AgentProposalCard embedded proposal={proposal()} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
    finish({ ok: true });
    await vi.waitFor(() =>
      expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(false)
    );
  });

  it("shows what confirming applies, not just the agent's summary", () => {
    render(
      <AgentProposalCard
        proposal={proposal({
          summary: "Tidy sleep buffer",
          payload: {
            command: "save_entity",
            body: { entityType: "setting", expectedVersion: 1, entity: { pulsePublishEnabled: true } }
          }
        })}
        onResolve={async () => ({ ok: true })}
      />
    );
    expect(screen.getByText("Tidy sleep buffer")).toBeTruthy();
    expect(screen.getByText("What confirming applies")).toBeTruthy();
    expect(screen.getByText("pulse publish enabled")).toBeTruthy();
    expect(screen.getByText("yes")).toBeTruthy();
  });

  it("shows every change of a long batch, with none collapsed", () => {
    const commands = Array.from({ length: 7 }, (_, i) => ({
      command: "save_project",
      body: { project: { title: `Project ${i}` } }
    }));
    render(
      <AgentProposalCard
        embedded
        proposal={proposal({ kind: "entity_command_batch", payload: { commands } })}
        onResolve={async () => ({ ok: true })}
      />
    );
    for (let i = 0; i < 7; i++) expect(screen.getByText(`Create project "Project ${i}"`)).toBeTruthy();
    expect(screen.queryByText(/Show all/)).toBeNull();
  });

  it("names the stored record an update overwrites, with the old and new value", () => {
    render(
      <AgentProposalCard
        embedded
        proposal={proposal({
          payload: {
            command: "save_action",
            body: { expectedVersion: 2, action: { id: "rent", text: "Free money", done: true } }
          }
        })}
        findRecord={() => ({ id: "rent", text: "Pay rent", done: false })}
        onResolve={async () => ({ ok: true })}
      />
    );
    expect(screen.getByText('Update action "Pay rent" (rent)')).toBeTruthy();
    expect(screen.getByText("no \u2192 yes")).toBeTruthy();
    expect(screen.queryByText(/Free money \u2192/)).toBeNull();
  });

  describe("plain language and risk", () => {
    const settingsPayload = {
      command: "save_entity",
      body: { entityType: "settings", expectedVersion: 4, entity: { timezone: "Australia/Sydney" } }
    };

    it("reads times in the plan zone, not the browser's, and leaves ids under Exact request", () => {
      render(
        <AgentProposalCard
          embedded
          timezone="America/New_York"
          proposal={proposal({
            payload: {
              command: "save_entity",
              body: {
                entityType: "commitment",
                entity: {
                  title: "Dentist",
                  startsAt: "2026-11-12T21:00:00Z",
                  endsAt: "2026-11-12T21:45:00Z",
                  projectId: "3040f868-dd69-50c8-ace2-7c1fc0c5"
                }
              }
            }
          })}
          onResolve={async () => ({ ok: true })}
        />
      );
      expect(screen.getByText("Thu 12 Nov, 4:00-4:45 pm")).toBeTruthy();
      const rows = document.querySelector("dl")!;
      expect(rows.textContent).not.toMatch(/3040f868|T21:00/);
      expect(document.querySelector("details pre")!.textContent).toContain("3040f868");
    });

    it("says what a timezone change does and makes Confirm secondary, not the primary action", () => {
      render(
        <AgentProposalCard
          embedded
          timezone="America/New_York"
          proposal={proposal({ payload: settingsPayload })}
          findRecord={(kind) => (kind === "settings" ? { timezone: "America/New_York" } : undefined)}
          onResolve={async () => ({ ok: true })}
        />
      );
      expect(screen.getByText(/Times already set will read \d+ h later\./)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Confirm" }).className).toMatch(/secondary/);
    });

    it("keeps Confirm primary in the Inbox for an ordinary change", () => {
      render(
        <AgentProposalCard
          embedded
          proposal={proposal({
            payload: { command: "save_project", body: { project: { title: "A" } } }
          })}
          onResolve={async () => ({ ok: true })}
        />
      );
      expect(screen.getByRole("button", { name: "Confirm" }).className).toMatch(/primary/);
      expect(screen.queryByText(/Times already set/)).toBeNull();
    });
  });

  it("cuts a very long value with a show-all disclosure holding the whole of it", () => {
    const long = "x".repeat(600);
    render(
      <AgentProposalCard
        embedded
        proposal={proposal({ payload: { command: "save_project", body: { project: { title: "T", notes: long } } } })}
        onResolve={async () => ({ ok: true })}
      />
    );
    const more = screen.getByText("show all").closest("details")!;
    expect(more.textContent).toContain(long);
    expect(document.body.textContent).toContain("x".repeat(500) + "…");
  });

  it("passes the revision it was rendered at and shows the changed message", async () => {
    const onResolve = vi.fn(async () => ({
      ok: false as const,
      stale: false,
      changed: true,
      message: "The agent changed this after you opened it. Read it again before confirming.",
      conflicts: []
    }));
    render(<AgentProposalCard embedded proposal={proposal({ revision: 4 })} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The agent changed this after you opened it.");
    expect(onResolve).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "confirm", 4);
  });

  it("keeps the exact request behind a disclosure", () => {
    const payload = { command: "save_project", body: { project: { title: "Thesis" } } };
    render(<AgentProposalCard proposal={proposal({ payload })} onResolve={async () => ({ ok: true })} />);
    const exact = screen.getByText("Exact request").closest("details")!;
    expect(exact.open).toBe(false);
    expect(exact.querySelector("pre")!.textContent).toBe(JSON.stringify(payload, null, 2));
  });

  it("warns when the portal cannot describe the change", () => {
    render(
      <AgentProposalCard
        proposal={proposal({ kind: "mystery", payload: { a: 1 } })}
        onResolve={async () => ({ ok: true })}
      />
    );
    expect(
      screen.getByText("This portal cannot describe this change; read the exact request before confirming.")
    ).toBeTruthy();
    expect(screen.getByText("Exact request")).toBeTruthy();
  });
});
