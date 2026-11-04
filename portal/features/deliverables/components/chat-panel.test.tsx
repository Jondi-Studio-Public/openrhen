// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { deliverable } from "@/features/deliverables/test-fixtures";
import type { PortalState } from "@/state/portal-state";
import { VERSION_CONFLICT_MESSAGE } from "@/shared/use-server-draft";
import { ChatPanel } from "./chat-panel";

const message = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: crypto.randomUUID(),
  role: "assistant",
  content: "Split it into three steps.",
  attachments: [],
  createdAt: "2026-08-25T08:00:00.000Z",
  ...overrides
});

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function mockFetch(handlers: Record<string, (init?: RequestInit) => unknown>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`Unexpected request ${key}`);
    const result = handler(init);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("ChatPanel", () => {
  it("loads the history and streams a reply through the chat API", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/d1/chat": () => ({ messages: [message({ content: "Earlier reply" })] }),
        "POST /api/deliverables/d1/chat": (init) => {
          sent.push(JSON.parse(String(init?.body)));
          return sseResponse([
            { kind: "delta", text: "Three " },
            { kind: "delta", text: "steps." },
            {
              kind: "done",
              messages: [
                message({ role: "user", content: "How do I split this?" }),
                message({ content: "Three steps." })
              ]
            }
          ]);
        }
      })
    );
    render(<ChatPanel deliverableId="d1" phase="Breakdown" editable timezone="Australia/Brisbane" />);
    expect(await screen.findByText("Earlier reply")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message the assistant"), { target: { value: "How do I split this?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Three steps.")).toBeTruthy();
    expect(sent).toEqual([{ text: "How do I split this?", images: [], allowEdits: true }]);
    expect((screen.getByLabelText("Message the assistant") as HTMLTextAreaElement).value).toBe("");
  });

  it("surfaces a mid-stream error and keeps the saved history", async () => {
    let historyCalls = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/d1/chat": () => ({
          messages: ++historyCalls > 1 ? [message({ role: "user", content: "How do I split this?" })] : []
        }),
        "POST /api/deliverables/d1/chat": () =>
          sseResponse([
            { kind: "delta", text: "Thr" },
            { kind: "error", error: "The assistant stream failed." }
          ])
      })
    );
    render(<ChatPanel deliverableId="d1" phase="Breakdown" editable timezone="Australia/Brisbane" />);
    const composer = await screen.findByLabelText("Message the assistant");
    fireEvent.change(composer, { target: { value: "How do I split this?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("The assistant stream failed.");
    // The user's turn was stored server-side before the model ran, so the reload shows it.
    expect(await screen.findByText("How do I split this?")).toBeTruthy();
  });

  it("withholds tool edits while a local draft is unsaved and accepts applied server state otherwise", async () => {
    const sent: unknown[] = [];
    const applied = vi.fn();
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/d1/chat": () => ({ messages: [] }),
        "POST /api/deliverables/d1/chat": (init) => {
          sent.push(JSON.parse(String(init?.body)));
          return sseResponse([
            { kind: "applied", state: { settings: { version: 9 }, deliverables: [] } },
            { kind: "delta", text: "Added." },
            { kind: "done", messages: [message({ role: "user", content: "yes" }), message({ content: "Added." })] }
          ]);
        }
      })
    );
    const view = render(
      <ChatPanel
        deliverableId="d1"
        phase="Breakdown"
        editable
        dirty
        timezone="Australia/Brisbane"
        onApplied={applied}
      />
    );
    const composer = await screen.findByLabelText("Message the assistant");
    fireEvent.change(composer, { target: { value: "yes" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Added.")).toBeTruthy();
    expect(sent).toEqual([{ text: "yes", images: [], allowEdits: false }]);
    expect(applied).toHaveBeenCalledWith({ settings: { version: 9 }, deliverables: [] });
    view.unmount();
  });

  describe("undoing a turn's changes", () => {
    const before = deliverable({ id: "d1", title: "Before the turn", version: 3 });
    const afterFirst = { ...before, title: "Mid turn", version: 4 };
    const afterLast = { ...before, title: "After the turn", version: 5 };
    const stateOf = (item: typeof before) => ({ deliverables: [item] }) as unknown as PortalState;

    function renderTurn(frames: unknown[], onUndo = vi.fn().mockResolvedValue(undefined)) {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          "GET /api/deliverables/d1/chat": () => ({ messages: [] }),
          "POST /api/deliverables/d1/chat": () =>
            sseResponse([
              ...frames,
              {
                kind: "done",
                messages: [message({ role: "user", content: "yes" }), message({ content: "Done that." })]
              }
            ])
        })
      );
      // The page re-renders with each applied state; the panel must have kept the first deliverable.
      const props = {
        deliverableId: "d1",
        phase: "Breakdown" as const,
        editable: true,
        timezone: "Australia/Brisbane"
      };
      const view = render(<ChatPanel {...props} deliverable={before} onUndo={onUndo} />);
      return {
        onUndo,
        send: async () => {
          fireEvent.change(await screen.findByLabelText("Message the assistant"), { target: { value: "yes" } });
          fireEvent.click(screen.getByRole("button", { name: "Send" }));
          await screen.findByText("Done that.");
          view.rerender(<ChatPanel {...props} deliverable={afterLast} onUndo={onUndo} />);
        },
        startDraft: () => view.rerender(<ChatPanel {...props} deliverable={afterLast} onUndo={onUndo} dirty />)
      };
    }

    it("offers the undo only after a turn that applied a change", async () => {
      const quiet = renderTurn([{ kind: "delta", text: "Done that." }]);
      await quiet.send();
      expect(screen.queryByRole("button", { name: "Undo these changes" })).toBeNull();
    });

    it("saves the pre-turn deliverable back against the version the turn left behind", async () => {
      const turn = renderTurn([
        { kind: "applied", state: stateOf(afterFirst) },
        { kind: "applied", state: stateOf(afterLast) }
      ]);
      await turn.send();
      fireEvent.click(screen.getByRole("button", { name: "Undo these changes" }));
      expect(await screen.findByText("Changes undone.")).toBeTruthy();
      expect(turn.onUndo).toHaveBeenCalledWith(before, 5);
      expect(screen.queryByRole("button", { name: "Undo these changes" })).toBeNull();
    });

    it("hides the undo while the workspace has an unsaved draft, which the restore would strand", async () => {
      const turn = renderTurn([{ kind: "applied", state: stateOf(afterLast) }]);
      await turn.send();
      turn.startDraft();
      expect(screen.queryByRole("button", { name: "Undo these changes" })).toBeNull();
    });

    it("says the deliverable changed since when the save is refused as a version conflict", async () => {
      const turn = renderTurn(
        [{ kind: "applied", state: stateOf(afterLast) }],
        vi.fn().mockRejectedValue(new Error(VERSION_CONFLICT_MESSAGE))
      );
      await turn.send();
      fireEvent.click(screen.getByRole("button", { name: "Undo these changes" }));
      expect(await screen.findByText(/changed since/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Undo these changes" })).toBeNull();
      expect(screen.queryByText("Changes undone.")).toBeNull();
    });

    it("keeps the button and shows the error when the undo fails for another reason", async () => {
      const turn = renderTurn(
        [{ kind: "applied", state: stateOf(afterLast) }],
        vi.fn().mockRejectedValue(new Error("The server could not be reached just now."))
      );
      await turn.send();
      fireEvent.click(screen.getByRole("button", { name: "Undo these changes" }));
      expect((await screen.findByRole("alert")).textContent).toContain("could not be reached");
      expect(screen.getByRole("button", { name: "Undo these changes" })).toBeTruthy();
    });
  });

  it("turns a pasted image into a removable attachment chip", async () => {
    vi.stubGlobal("fetch", mockFetch({ "GET /api/deliverables/d1/chat": () => ({ messages: [] }) }));
    render(<ChatPanel deliverableId="d1" phase="Breakdown" editable timezone="Australia/Brisbane" />);
    const composer = await screen.findByLabelText("Message the assistant");
    const file = new File(["png-bytes"], "rubric.png", { type: "image/png" });
    fireEvent.paste(composer, {
      clipboardData: { items: [{ kind: "file", getAsFile: () => file }] }
    });
    expect(await screen.findByAltText("rubric.png")).toBeTruthy();
    // With an image staged, Send is live even with no text.
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove rubric.png" }));
    expect(screen.queryByAltText("rubric.png")).toBeNull();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("re-reads the thread when the workspace attaches a source behind its back", async () => {
    let historyCalls = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/d1/chat": () => ({
          messages: ++historyCalls > 1 ? [message({ content: "I can now see “Assessment brief” (brief.pdf)." })] : []
        })
      })
    );
    const view = render(
      <ChatPanel deliverableId="d1" phase="Breakdown" editable reloadKey={0} timezone="Australia/Brisbane" />
    );
    expect(await screen.findByLabelText("Message the assistant")).toBeTruthy();
    view.rerender(
      <ChatPanel deliverableId="d1" phase="Breakdown" editable reloadKey={1} timezone="Australia/Brisbane" />
    );
    expect(await screen.findByText(/I can now see “Assessment brief”/)).toBeTruthy();
  });

  it("shows history read-only outside a session", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ "GET /api/deliverables/d1/chat": () => ({ messages: [message({ content: "Earlier reply" })] }) })
    );
    render(<ChatPanel deliverableId="d1" phase="Breakdown" editable={false} timezone="Australia/Brisbane" />);
    expect(await screen.findByText("Earlier reply")).toBeTruthy();
    expect(screen.queryByLabelText("Message the assistant")).toBeNull();
    expect(screen.getByText("Start the deliverable from Now to talk to the assistant.")).toBeTruthy();
  });

  it("collapses a long stored message behind a line-count toggle", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`);
    vi.stubGlobal(
      "fetch",
      mockFetch({ "GET /api/deliverables/d1/chat": () => ({ messages: [message({ content: lines.join("\n") })] }) })
    );
    render(<ChatPanel deliverableId="d1" phase="Breakdown" editable={false} timezone="Australia/Brisbane" />);
    const toggle = await screen.findByRole("button", { name: "Show all 40 lines" });
    expect(screen.queryByText(/Line 40/)).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText(/Line 40/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it('renders **bold** spans and "- " lines as a bullet list, not literal markdown', async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/d1/chat": () => ({
          messages: [message({ content: "Here is **the plan**:\n- Draft the outline\n- Write the intro" })]
        })
      })
    );
    render(<ChatPanel deliverableId="d1" phase="Breakdown" editable={false} timezone="Australia/Brisbane" />);
    const bold = await screen.findByText("the plan");
    expect(bold.tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*/)).toBeNull();
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Draft the outline", "Write the intro"]);
  });

  it("renders a short stored message with no collapse toggle", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ "GET /api/deliverables/d1/chat": () => ({ messages: [message({ content: "Line one\nLine two" })] }) })
    );
    render(<ChatPanel deliverableId="d1" phase="Breakdown" editable={false} timezone="Australia/Brisbane" />);
    expect(await screen.findByText("Line one Line two")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("changes its role and guidance with the workspace phase", async () => {
    vi.stubGlobal("fetch", mockFetch({ "GET /api/deliverables/d1/chat": () => ({ messages: [] }) }));
    const view = render(<ChatPanel deliverableId="d1" phase="Carry out" editable timezone="Australia/Brisbane" />);
    expect(await screen.findByText("Working assistant")).toBeTruthy();
    expect(screen.getByText(/show me progress as you go/i)).toBeTruthy();
    expect((screen.getByLabelText("Message the assistant") as HTMLTextAreaElement).placeholder).toContain(
      "progress images"
    );
    view.rerender(<ChatPanel deliverableId="d1" phase="Review" editable timezone="Australia/Brisbane" />);
    expect(screen.getByText("Review assistant")).toBeTruthy();
    expect(screen.getByText(/criterion by criterion/i)).toBeTruthy();
  });

  it("copies the handoff prompt to the clipboard and shows a brief confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/d1/chat": () => ({
          messages: [],
          coordination: { handedOff: false, tool: null, since: null, lastDropOffSummary: null },
          prompts: { handoff: "Run pick-up for Essay draft.", bringBack: "Run drop-off." }
        })
      })
    );
    render(<ChatPanel deliverableId="d1" phase="Breakdown" editable timezone="Australia/Brisbane" />);
    expect(await screen.findByLabelText("Coordinate in a desktop AI")).toBeTruthy();
    const button = await screen.findByRole("button", { name: "Copy the handoff prompt" });
    fireEvent.click(button);
    await screen.findByRole("status");
    expect(writeText).toHaveBeenCalledWith("Run pick-up for Essay draft.");
  });

  it("leads with the handoff offer and shows the chat below it labelled a backup", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/d1/chat": () => ({
          messages: [],
          coordination: { handedOff: false, tool: null, since: null, lastDropOffSummary: null },
          prompts: { handoff: "Run pick-up for Essay draft.", bringBack: "Run drop-off." }
        })
      })
    );
    render(<ChatPanel deliverableId="d1" phase="Breakdown" editable timezone="Australia/Brisbane" />);
    const offer = await screen.findByLabelText("Coordinate in a desktop AI");
    const fallback = await screen.findByLabelText("Breakdown assistant conversation (backup)");
    // DOM order is document order: the handoff offer precedes the chat backup panel it leads.
    expect(offer.compareDocumentPosition(fallback) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(fallback).getByText("Backup")).toBeTruthy();
  });

  it("falls back to a copyable textarea when the clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/d1/chat": () => ({
          messages: [],
          coordination: { handedOff: false, tool: null, since: null, lastDropOffSummary: null },
          prompts: { handoff: "Run pick-up for Essay draft.", bringBack: "Run drop-off." }
        })
      })
    );
    render(<ChatPanel deliverableId="d1" phase="Breakdown" editable timezone="Australia/Brisbane" />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy the handoff prompt" }));
    expect(await screen.findByLabelText("Handoff prompt")).toBeTruthy();
  });

  it("renders an external note row distinctly from a chat bubble", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/d1/chat": () => ({
          messages: [
            {
              id: "e1",
              role: "external",
              content: "Added three steps to the plan.",
              attachments: [],
              createdAt: "2026-09-07T01:00:00.000Z",
              meta: { kind: "note", tool: "Claude Desktop" }
            }
          ]
        })
      })
    );
    render(<ChatPanel deliverableId="d1" phase="Carry out" editable={false} timezone="Australia/Brisbane" />);
    expect(await screen.findByText("Added three steps to the plan.")).toBeTruthy();
    expect(screen.getByText(/Claude Desktop · note ·/)).toBeTruthy();
    const row = document.querySelector(".chat-message.external");
    expect(row).toBeTruthy();
    expect(row?.classList.contains("user")).toBe(false);
    expect(row?.classList.contains("assistant")).toBe(false);
  });

  it("labels a drop-off row's content as a summary", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/d1/chat": () => ({
          messages: [
            {
              id: "e2",
              role: "external",
              content: "Decided the structure, drafted the intro, left the conclusion open.",
              attachments: [],
              createdAt: "2026-09-07T02:00:00.000Z",
              meta: { kind: "drop_off", tool: "Codex CLI" }
            }
          ]
        })
      })
    );
    render(<ChatPanel deliverableId="d1" phase="Carry out" editable={false} timezone="Australia/Brisbane" />);
    expect(await screen.findByText(/Summary from Codex CLI/)).toBeTruthy();
  });

  it("reports coordination state and prompts up to the caller once the thread loads", async () => {
    const onCoordination = vi.fn();
    const coordination = {
      handedOff: true,
      tool: "Claude Desktop",
      since: "2026-09-07T00:00:00.000Z",
      lastDropOffSummary: null
    };
    const prompts = { handoff: "Run pick-up.", bringBack: "Run drop-off." };
    vi.stubGlobal(
      "fetch",
      mockFetch({ "GET /api/deliverables/d1/chat": () => ({ messages: [], coordination, prompts }) })
    );
    render(
      <ChatPanel
        deliverableId="d1"
        phase="Breakdown"
        editable
        timezone="Australia/Brisbane"
        onCoordination={onCoordination}
      />
    );
    await vi.waitFor(() => expect(onCoordination).toHaveBeenCalledWith(coordination, prompts));
  });
});
