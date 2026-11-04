// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProposal } from "@openrhen/contracts";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { emptyProposalDraft } from "@/features/capture/proposal-draft";
import { buildTitleResolver } from "@/features/plan-map/plan-map-model";
import { finding, link, planMap, titles } from "@/features/plan-map/test-fixtures";
import type { CaptureItem } from "@/state/portal-state";
import { registerPortalExtension } from "@/state/portal-extensions";
import { FAKE_MAIL_SOURCE_TYPE, registerFakeMailSource } from "@/test/fake-mail-source";
import type { QueueEntry } from "../queue";

const push = vi.fn();
const confirmReviewed = vi.fn();
const ignore = vi.fn();
const dropKept = vi.fn();
const deleteBatch = vi.fn();
const commit = vi.fn();
const openBatch = vi.fn();
const reopen = vi.fn();
const decideLink = vi.fn();
const decideFinding = vi.fn();
const markSeen = vi.fn();
let inbox: Record<string, unknown>;

// The core Inbox only: the seam is stubbed empty, as it is in the OpenRhen export, and a stand-in mail source is registered.
vi.mock("@/state/private/index", () => ({}));
registerFakeMailSource();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../inbox-provider", () => ({ useInbox: () => inbox }));
vi.mock("@/state/portal-provider", () => ({
  usePortal: () => ({ state: { captures: [], settings: { timezone: "America/New_York" } } })
}));
vi.mock("./batch-review", () => ({
  BatchReview: ({ onClose, closeLabel = "Close review" }: { onClose?: () => void; closeLabel?: string }) => (
    <div data-testid="batch-review">
      <button onClick={onClose}>{closeLabel}</button>
    </div>
  )
}));

const { QueueDetail } = await import("./queue-detail");

const capture = (overrides: Partial<CaptureItem> = {}): CaptureItem => ({
  id: "c1",
  text: "Buy a gift for Nan",
  status: "pending",
  proposalType: "action",
  proposedFields: {},
  sourceType: "manual_capture",
  createdAt: "2026-10-27T01:00:00.000Z",
  ...overrides
});

const emailItem = {
  id: "e1",
  version: 1,
  text: "One visit",
  status: "pending",
  proposalType: "email_change",
  proposedFields: {
    ref: "e1",
    title: "Bring PPE",
    subject: "Site visit",
    newestAt: "2026-09-10T00:00:00.000Z",
    op: "action",
    fields: { title: "Bring PPE" },
    placement: {}
  },
  sourceType: FAKE_MAIL_SOURCE_TYPE,
  sourceId: "s1",
  createdAt: "2026-09-10T01:00:00.000Z"
};

const state = { areas: [], outcomes: [], projects: [], conditionDefinitions: [] };

const imports = (extra: Record<string, unknown> = {}) => ({
  batch: null,
  busy: false,
  deleteBatch,
  commit,
  reviewStatus: { error: "", notice: "" },
  blocking: 0,
  calendarRecords: [],
  selectedCalendarRecords: [],
  ...extra
});

function setInbox(overrides: Record<string, unknown> = {}, proposals: Record<string, unknown> = {}) {
  inbox = {
    proposals: {
      reviewingId: "c1",
      state,
      draft: { ...emptyProposalDraft(), proposalType: "action" },
      error: "",
      setDraft: vi.fn(),
      questions: [],
      placementSuggestion: null,
      answers: {},
      setAnswers: vi.fn(),
      keptError: "",
      reopen,
      emailChangeContext: {
        timezone: "UTC",
        projects: [],
        outcomes: [],
        titleOf: () => undefined,
        placeName: () => undefined
      },
      ...proposals
    },
    imports: imports(),
    decisions: { leaving: new Map() },
    planMap: {
      resolver: buildTitleResolver(titles, planMap()),
      busy: false,
      decideLink,
      decideFinding
    },
    ignore,
    confirmReviewed,
    confirmEmailChange: vi.fn(),
    dropKept,
    openBatch,
    ...overrides
  };
}

const entry = (kind: string, fields: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  ({
    kind,
    key: `${kind}:x`,
    room: "captured",
    title: "The title",
    meta: "The meta",
    tag: { label: "The tag", tone: "neutral" },
    waiting: true,
    ...fields,
    ...overrides
  }) as unknown as QueueEntry;

const captureEntry = (item: CaptureItem, overrides: Record<string, unknown> = {}) =>
  entry("capture", { item }, overrides);
const keptEntry = (item: CaptureItem) => entry("kept", { item, shelf: "someday" }, { room: "kept", waiting: false });
const action = (name: string) => document.querySelector(`[data-inbox-action="${name}"]`) as HTMLButtonElement | null;

beforeEach(() => {
  for (const spy of [
    push,
    commit,
    confirmReviewed,
    ignore,
    dropKept,
    deleteBatch,
    openBatch,
    reopen,
    decideLink,
    decideFinding,
    markSeen
  ])
    spy.mockReset();
  reopen.mockResolvedValue(true);
  setInbox();
});

describe("QueueDetail head", () => {
  it("shows the tag, the meta line and the title above the body", () => {
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.getByText("The tag")).toBeTruthy();
    expect(screen.getByText("The meta")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "The title" })).toBeTruthy();
  });

  it("leaves the meta line out for an email and an agent proposal, which say it in their own body", () => {
    const proposal = {
      id: "p1",
      agent: "scribe",
      summary: "S",
      evidence: "",
      basis: "stated",
      revision: 1,
      createdAt: new Date().toISOString()
    };
    const { unmount } = render(<QueueDetail entry={entry("agent", { proposal })} />);
    expect(screen.queryByText("The meta")).toBeNull();
    unmount();
    render(<QueueDetail entry={entry("email", { items: [emailItem] })} />);
    expect(screen.queryByText("The meta")).toBeNull();
  });
});

describe("CaptureDetail", () => {
  it("says Opening… until the proposal under review is this capture", () => {
    setInbox({}, { reviewingId: null });
    const { rerender } = render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.getByText("Opening…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to plan" })).toBeNull();
    setInbox({}, { reviewingId: "other" });
    rerender(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.getByText("Opening…")).toBeTruthy();
    setInbox();
    rerender(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.queryByText("Opening…")).toBeNull();
    expect(screen.getByRole("button", { name: "Add to plan" })).toBeTruthy();
  });

  it("quotes the note, or the captured text when the proposal has its own title", () => {
    const { unmount } = render(
      <QueueDetail entry={captureEntry(capture({ proposedFields: { title: "Gift", note: "For her birthday" } }))} />
    );
    expect(screen.getByText('"For her birthday"')).toBeTruthy();
    unmount();
    const titled = render(<QueueDetail entry={captureEntry(capture({ proposedFields: { title: "Gift" } }))} />);
    expect(screen.getByText('"Buy a gift for Nan"')).toBeTruthy();
    titled.unmount();
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("does not quote the text again when it is the title", () => {
    render(<QueueDetail entry={captureEntry(capture({ proposedFields: { title: "Buy a gift for Nan" } }))} />);
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("links to the source when there is one", () => {
    render(<QueueDetail entry={captureEntry(capture({ sourceLink: "https://example.com/m" }))} />);
    expect(screen.getByRole("link", { name: "View source" }).getAttribute("href")).toBe("https://example.com/m");
  });

  it("adds to the plan with Add to plan, marked as yes", () => {
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(action("yes")!.textContent).toBe("Add to plan");
    fireEvent.click(screen.getByRole("button", { name: "Add to plan" }));
    expect(confirmReviewed).toHaveBeenCalledWith();
  });

  it("ignores the capture by its id with Ignore, marked as no", () => {
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(action("no")!.textContent).toBe("Ignore");
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    expect(ignore).toHaveBeenCalledWith(["c1"]);
  });

  it("hides the fields behind Change first for a sorted capture, then reveals them", () => {
    setInbox({}, { state: { ...state, projects: [{ id: "p1", title: "Packing", status: "active" }] } });
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.queryByLabelText("Corrected title")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change first" }));
    expect(screen.getByLabelText("Corrected title")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change first" })).toBeNull();
  });

  it("opens the fields straight away for an unclassified capture", () => {
    setInbox({}, { draft: emptyProposalDraft() });
    render(<QueueDetail entry={captureEntry(capture({ proposalType: "unclassified" }))} />);
    expect(screen.getByLabelText("Corrected title")).toBeTruthy();
    // The chips choose the type, so the select is not repeated.
    expect(screen.queryByLabelText("What should this become?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change first" })).toBeNull();
  });

  it("keeps its open questions in the card and holds Add to plan until they are answered", () => {
    setInbox(
      {},
      { questions: [{ field: "projectId", question: "Which project?", suggestions: ["Packing"], input: "text" }] }
    );
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.getByText("Which project?")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add to plan" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("CaptureDetail plan effect and project choice", () => {
  const projectsState = {
    ...state,
    projects: [
      { id: "p1", title: "Packing", status: "active" },
      { id: "p2", title: "Move house", status: "active" },
      { id: "p3", title: "Tax", status: "active" },
      { id: "p4", title: "Garden", status: "active" }
    ]
  };
  const withDraft = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const setDraft = vi.fn();
    setInbox(
      {},
      { state: projectsState, draft: { ...emptyProposalDraft(), title: "Pack boxes", ...patch }, setDraft, ...extra }
    );
    return setDraft;
  };

  it("leads with what adding it does to the plan", () => {
    withDraft({ proposalType: "action", projectId: "p1" });
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.getByText("What it does to your plan")).toBeTruthy();
    expect(screen.getByText("Adds the action “Pack boxes” under Packing.")).toBeTruthy();
  });

  it("shows no effect for an unclassified capture", () => {
    withDraft({ proposalType: "unclassified" });
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.queryByText("What it does to your plan")).toBeNull();
    expect(screen.queryByText("Which project does it belong to?")).toBeNull();
  });

  it.each(["action", "deliverable"])("offers up to three project chips plus Other… for a %s", (type) => {
    withDraft({ proposalType: type });
    render(<QueueDetail entry={captureEntry(capture())} />);
    const group = screen.getByRole("group", { name: "Which project does it belong to?" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent)
    ).toEqual(["Packing", "Move house", "Tax", "Other…"]);
  });

  it("offers no project chips for other types", () => {
    withDraft({ proposalType: "fixed_commitment" });
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.queryByText("Which project does it belong to?")).toBeNull();
  });

  it("puts the chosen and suggested projects first and marks the chosen one pressed", () => {
    withDraft({ proposalType: "action", projectId: "p4" }, { placementSuggestion: { projectId: "p3" } });
    render(<QueueDetail entry={captureEntry(capture())} />);
    const group = screen.getByRole("group", { name: "Which project does it belong to?" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((b) => b.textContent)).toEqual(["Garden", "Tax", "Packing", "Other…"]);
    expect(chips[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(chips[1]!.getAttribute("aria-pressed")).toBe("false");
  });

  it("sets the draft's project when a chip is clicked", () => {
    const setDraft = withDraft({ proposalType: "action" });
    render(<QueueDetail entry={captureEntry(capture())} />);
    fireEvent.click(screen.getByRole("button", { name: "Move house" }));
    expect(setDraft).toHaveBeenCalledWith(expect.objectContaining({ proposalType: "action", projectId: "p2" }));
  });

  it("opens the fields and drops the chips on Other…", () => {
    withDraft({ proposalType: "action" });
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.queryByLabelText("Corrected title")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Other…" }));
    expect(screen.getByLabelText("Corrected title")).toBeTruthy();
    expect(screen.queryByText("Which project does it belong to?")).toBeNull();
  });

  it("drops the chips on Change first", () => {
    withDraft({ proposalType: "deliverable" });
    render(<QueueDetail entry={captureEntry(capture())} />);
    fireEvent.click(screen.getByRole("button", { name: "Change first" }));
    expect(screen.queryByText("Which project does it belong to?")).toBeNull();
    expect(screen.getByLabelText("Corrected title")).toBeTruthy();
  });
});

describe("CaptureDetail type chips", () => {
  const projectsState = { ...state, projects: [{ id: "p1", title: "Packing", status: "active" }] };
  const withType = (proposalType: string, extra: Record<string, unknown> = {}) => {
    const setDraft = vi.fn();
    setInbox(
      {},
      {
        state: projectsState,
        draft: { ...emptyProposalDraft(), title: "Ink", proposalType, projectId: "p1" },
        setDraft,
        ...extra
      }
    );
    return setDraft;
  };
  const group = () => screen.getByRole("group", { name: "What is it?" });

  it("labels the chip row and shows no type select beside it", () => {
    withType("action");
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.getByText("What is it?")).toBeTruthy();
    expect(screen.queryByLabelText("What should this become?")).toBeNull();
  });

  it("makes Ignore a plain button, not a toggle chip", () => {
    withType("action");
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(action("no")!.hasAttribute("aria-pressed")).toBe(false);
  });

  it("offers Task, At a time, Later and Ignore, with the guessed one pressed", () => {
    withType("action");
    render(<QueueDetail entry={captureEntry(capture())} />);
    const chips = within(group()).getAllByRole("button");
    expect(chips.map((b) => b.textContent)).toEqual(["Task", "At a time", "Later", "Ignore"]);
    expect(chips.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", null]);
  });

  it("files a preselected task with one tap on Add to plan, with no form open", () => {
    withType("action");
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.queryByLabelText("Corrected title")).toBeNull();
    expect(screen.queryByLabelText("What should this become?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add to plan" }));
    expect(confirmReviewed).toHaveBeenCalledWith();
  });

  it("moves the draft to the tapped chip", () => {
    const setDraft = withType("action");
    render(<QueueDetail entry={captureEntry(capture())} />);
    fireEvent.click(within(group()).getByRole("button", { name: "Later" }));
    expect(setDraft).toHaveBeenCalledWith(expect.objectContaining({ proposalType: "someday" }));
  });

  it("says Keep for later on Later, and Ignore chip is the ignore button", () => {
    withType("someday");
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.getByRole("button", { name: "Keep for later" })).toBeTruthy();
    expect(action("no")!.textContent).toBe("Ignore");
    fireEvent.click(action("no")!);
    expect(ignore).toHaveBeenCalledWith(["c1"]);
  });

  it("opens the form for At a time, which needs its times", () => {
    withType("fixed_commitment");
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.getByLabelText("Starts")).toBeTruthy();
  });

  it("opens the form for a task when there is no project at all", () => {
    setInbox({}, { draft: { ...emptyProposalDraft(), proposalType: "action" } });
    render(<QueueDetail entry={captureEntry(capture())} />);
    expect(screen.getByLabelText("Project")).toBeTruthy();
  });

  it("drops the chips once Change first opens the full form", () => {
    withType("action");
    render(<QueueDetail entry={captureEntry(capture())} />);
    fireEvent.click(screen.getByRole("button", { name: "Change first" }));
    expect(screen.queryByRole("group", { name: "What is it?" })).toBeNull();
    expect(action("no")!.textContent).toBe("Ignore");
  });
});

describe("KeptDetail", () => {
  const kept = () => keptEntry(capture({ status: "confirmed", proposalType: "someday" }));

  it("reopens the item and follows it to Captured, naming it in the address", async () => {
    render(<QueueDetail entry={kept()} />);
    expect(action("yes")!.textContent).toBe("Review again");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Review again" }));
    });
    expect(reopen).toHaveBeenCalledWith("c1");
    expect(push).toHaveBeenCalledWith("/inbox/captured?item=capture%3Ac1", { scroll: false });
  });

  it("does not navigate when the reopen fails", async () => {
    reopen.mockResolvedValue(false);
    render(<QueueDetail entry={kept()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Review again" }));
    });
    expect(reopen).toHaveBeenCalledWith("c1");
    expect(push).not.toHaveBeenCalled();
  });

  it("drops the item with Drop, marked as no", () => {
    render(<QueueDetail entry={kept()} />);
    expect(action("no")!.textContent).toBe("Drop");
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(dropKept).toHaveBeenCalledWith("c1");
  });

  it("shows why a reopen or drop failed", () => {
    setInbox({}, { keptError: "That could not be filed again." });
    render(<QueueDetail entry={kept()} />);
    expect(screen.getByRole("alert").textContent).toBe("That could not be filed again.");
  });

  it("shows no alert when nothing went wrong, and links to the source when there is one", () => {
    const { unmount } = render(<QueueDetail entry={kept()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();
    render(<QueueDetail entry={keptEntry(capture({ sourceLink: "https://example.com/s" }))} />);
    expect(screen.getByRole("link", { name: "View source" }).getAttribute("href")).toBe("https://example.com/s");
  });
});

describe("BatchDetail and DiscardBatch", () => {
  const calendar = () =>
    entry("calendar", { batchId: "b1", provider: "google_calendar", count: 2 }, { room: "calendar" });
  const held = () => entry("import", { batch: { id: "b2" } }, { room: "calendar", waiting: false });

  it("offers Open review (yes) and Discard (no) until the batch is the one loaded", () => {
    const { rerender } = render(<QueueDetail entry={calendar()} />);
    expect(screen.queryByTestId("batch-review")).toBeNull();
    expect(action("yes")!.textContent).toBe("Open review");
    expect(action("no")!.textContent).toBe("Discard");
    fireEvent.click(screen.getByRole("button", { name: "Open review" }));
    expect(openBatch).toHaveBeenCalledWith("b1");
    setInbox({ imports: imports({ batch: { id: "other", records: [] } }) });
    rerender(<QueueDetail entry={calendar()} />);
    expect(screen.getByRole("button", { name: "Open review" })).toBeTruthy();
    expect(screen.queryByText("What it does to your plan")).toBeNull();
  });

  it("uses the held import's own batch id", () => {
    render(<QueueDetail entry={held()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open review" }));
    expect(openBatch).toHaveBeenCalledWith("b2");
  });

  it("disables Open review while an import is busy", () => {
    setInbox({ imports: imports({ busy: true }) });
    render(<QueueDetail entry={calendar()} />);
    expect((screen.getByRole("button", { name: "Open review" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["a calendar's batch", calendar, "b1"],
    ["a held import", held, "b2"]
  ])("discards %s only after asking", (_name, make, id) => {
    render(<QueueDetail entry={make()} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(deleteBatch).not.toHaveBeenCalled();
    const group = screen.getByRole("group", { name: "Discard this import?" });
    expect(within(group).getByText("Discard this import? Nothing committed is affected.")).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "Discard" }));
    expect(deleteBatch).toHaveBeenCalledWith(id);
  });

  it("backs out with Keep it without discarding", () => {
    render(<QueueDetail entry={held()} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(deleteBatch).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Discard this import?" })).toBeNull();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
  });

  it("disables Discard while an import is busy", () => {
    setInbox({ imports: imports({ busy: true }) });
    render(<QueueDetail entry={held()} />);
    expect((screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("BatchDetail once the batch is loaded", () => {
  const field = (value: unknown) => ({
    value,
    basis: "explicit",
    confidence: "high",
    evidence: [],
    needsReview: false
  });
  const event = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
    id,
    importKey: `example_shared:event:${id}`,
    entityType: "fixed_commitment",
    operation: "create",
    relationships: {},
    errors: [],
    removed: false,
    fields: { title: field(title) },
    ...patch
  });
  const calendar = () =>
    entry("calendar", { batchId: "b1", provider: "google_calendar", count: 2 }, { room: "calendar" });
  const load = (extra: Record<string, unknown> = {}, records = [event("1", "Swim squad"), event("2", "Piano")]) => {
    const records_ = records;
    setInbox({
      imports: imports({
        batch: { id: "b1", status: "ready", timezone: "Australia/Sydney", records: records_ },
        calendarRecords: records_,
        selectedCalendarRecords: records_,
        ...extra
      })
    });
  };

  it("leads with the effect sentence and a line per record, then Add to plan, Change first and Discard", () => {
    load();
    render(<QueueDetail entry={calendar()} />);
    expect(screen.getByText("What it does to your plan")).toBeTruthy();
    expect(screen.getByText("Adds 2 events to your calendar. Nothing is written until you add it.")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Swim squad", "Piano"]);
    expect(screen.queryByTestId("batch-review")).toBeNull();
    expect(action("yes")!.textContent).toBe("Add to plan");
    expect(action("no")!.textContent).toBe("Discard");
    expect(screen.getByRole("button", { name: "Change first" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open review" })).toBeNull();
  });

  it("lists up to five lines and then says how many more", () => {
    load(
      {},
      Array.from({ length: 8 }, (_, at) => event(String(at), `Event ${at}`))
    );
    render(<QueueDetail entry={calendar()} />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Event 0", "Event 1", "Event 2", "Event 3", "Event 4", "and 3 more"]);
  });

  it("shows exactly five lines without an and-more line", () => {
    load(
      {},
      Array.from({ length: 5 }, (_, at) => event(String(at), `Event ${at}`))
    );
    render(<QueueDetail entry={calendar()} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByText(/and \d+ more/)).toBeNull();
  });

  it("adds to the plan through imports.commit when the batch is ready, unblocked and has events selected", () => {
    load();
    render(<QueueDetail entry={calendar()} />);
    const add = screen.getByRole("button", { name: "Add to plan" }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    expect(document.querySelector(".microcopy")).toBeNull();
    fireEvent.click(add);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "the batch is not ready",
      { batch: { id: "b1", status: "draft", timezone: "UTC", records: [] } },
      /not been checked yet/
    ],
    ["records are blocking", { blocking: 2 }, /2 need a fix before this can be added/],
    ["one record is blocking", { blocking: 1 }, /1 needs a fix before this can be added/],
    ["calendar events exist but none is selected", { selectedCalendarRecords: [] }, /not been checked yet/]
  ])("disables Add to plan and says why when %s", (_name, extra, why) => {
    load(extra);
    render(<QueueDetail entry={calendar()} />);
    const add = screen.getByRole("button", { name: "Add to plan" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(document.querySelector(".microcopy")!.textContent).toMatch(why);
    fireEvent.click(add);
    expect(commit).not.toHaveBeenCalled();
  });

  it("allows Add to plan for a batch with no calendar records at all", () => {
    load({ calendarRecords: [], selectedCalendarRecords: [] }, [
      event("1", "Pay rego", { entityType: "action", importKey: "csv:1" })
    ]);
    render(<QueueDetail entry={entry("import", { batch: { id: "b1" } }, { room: "calendar" })} />);
    expect((screen.getByRole("button", { name: "Add to plan" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Adds 1 item to your plan. Nothing is written until you add it.")).toBeTruthy();
  });

  it("shows the review's own error above the summary", () => {
    load({ reviewStatus: { error: "The batch could not be checked.", notice: "" } });
    render(<QueueDetail entry={calendar()} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("The batch could not be checked.");
    expect(
      alert.compareDocumentPosition(screen.getByText("What it does to your plan")) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows the review's notice, and nothing when the status is clear", () => {
    load({ reviewStatus: { error: "", notice: "Checked just now." } });
    const { unmount } = render(<QueueDetail entry={calendar()} />);
    expect(screen.getByRole("status").textContent).toBe("Checked just now.");
    unmount();
    load();
    render(<QueueDetail entry={calendar()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says in the summary how many records need a fix, apart from those it can add", () => {
    const records = [event("1", "Swim squad"), event("2", "Piano", { errors: ["No time"] })];
    load({ blocking: 1 }, records);
    render(<QueueDetail entry={calendar()} />);
    expect(screen.getByText("Adds 1 event to your calendar. 1 needs a fix first.")).toBeTruthy();
  });

  it("disables Add to plan while an import is busy", () => {
    load({ busy: true });
    render(<QueueDetail entry={calendar()} />);
    expect((screen.getByRole("button", { name: "Add to plan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the full review behind Change first, and Done changing returns to the summary", () => {
    load();
    render(<QueueDetail entry={calendar()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change first" }));
    expect(screen.getByTestId("batch-review")).toBeTruthy();
    expect(screen.queryByText("What it does to your plan")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done changing" }));
    expect(screen.queryByTestId("batch-review")).toBeNull();
    expect(screen.getByText("What it does to your plan")).toBeTruthy();
  });

  it("discards from the summary only after asking", () => {
    load();
    render(<QueueDetail entry={calendar()} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(deleteBatch).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("group", { name: "Discard this import?" })).getByRole("button", { name: "Discard" })
    );
    expect(deleteBatch).toHaveBeenCalledWith("b1");
  });
});

describe("each kind's body", () => {
  it("renders an agent proposal with Confirm and Reject marked as yes and no", () => {
    const proposal: AgentProposal = {
      id: "p1",
      agent: "scribe",
      kind: "entity_command",
      summary: "Move the dentist",
      payload: {},
      basis: "stated",
      evidence: "can we do Friday",
      targetVersions: {},
      status: "pending",
      coalesceKey: null,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null
    };
    const { container } = render(<QueueDetail entry={entry("agent", { proposal }, { title: "Move the dentist" })} />);
    // The Inbox gives the card its embedded mode, so it carries none of the standalone card's edge.
    expect(container.querySelector("article")!.className).not.toContain("review-card");
    // The title is the heading, so the bare card does not repeat the summary.
    expect(screen.getAllByText("Move the dentist")).toHaveLength(1);
    expect(screen.getByText("Agent's evidence: can we do Friday")).toBeTruthy();
    expect(action("yes")!.textContent).toBe("Confirm");
    expect(action("no")!.textContent).toBe("Reject");
  });

  it("renders a registered extension's row through its own renderer", () => {
    registerPortalExtension({ id: "example-rows", renderQueueRow: (row) => <p>Row {String(row.data)}</p> });
    const row = {
      key: "x:1",
      room: "people",
      title: "T",
      meta: "M",
      tag: { label: "L", tone: "neutral" },
      waiting: true,
      data: "one"
    };
    render(<QueueDetail entry={entry("extension", { extensionId: "example-rows", row })} />);
    expect(screen.getByText("Row one")).toBeTruthy();
  });

  it("renders a suggested link and sends its decision through the plan map", () => {
    const suggested = link({ id: "l9" });
    render(<QueueDetail entry={entry("link", { link: suggested }, { room: "map" })} />);
    fireEvent.click(action("yes")!);
    expect(decideLink).toHaveBeenCalledWith("l9", "confirm");
    fireEvent.click(action("no")!);
    expect(decideLink).toHaveBeenCalledWith("l9", "reject");
  });

  it("renders a finding and sends its decision through the plan map", () => {
    const open = finding({ id: "f9" });
    render(<QueueDetail entry={entry("finding", { finding: open }, { room: "map" })} />);
    fireEvent.click(action("yes")!);
    expect(decideFinding).toHaveBeenCalledWith("f9", "accept", undefined);
    fireEvent.click(action("no")!);
    expect(decideFinding).toHaveBeenCalledWith("f9", "dismiss", undefined);
  });

  it("disables a link's buttons while the plan map is busy", () => {
    setInbox({ planMap: { resolver: buildTitleResolver(titles, planMap()), busy: true, decideLink, decideFinding } });
    render(<QueueDetail entry={entry("link", { link: link() }, { room: "map" })} />);
    expect(action("yes")!.disabled).toBe(true);
  });

  it("renders an email thread through the registered mail source's card, headless", () => {
    render(<QueueDetail entry={entry("email", { items: [emailItem] }, { title: "Site visit", room: "emails" })} />);
    expect(screen.getByTestId("mail-card").textContent).toBe("1 mail changes");
  });
});
