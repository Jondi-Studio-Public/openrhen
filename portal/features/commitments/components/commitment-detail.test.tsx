// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { registerConnectionManifest } from "@openrhen/contracts";

// A shared calendar the plan also publishes to, which the provenance line words as "the X calendar".
registerConnectionManifest({
  id: "example_sink",
  label: "Example Sink",
  capabilities: ["calendar_source", "calendar_sink"],
  ops: { calendar_source: ["proof", "read_events"] },
  secrets: { anyOf: [["EXAMPLE_SINK_TOKEN"]] },
  config: {},
  calendarSource: {
    role: "secondary",
    sourceType: "example_sink_event",
    diffProfile: "shared_calendar",
    authFailure: { anyFailure: true, reasons: [] },
    schedule: { kind: "interval", minutesEnv: "CALENDAR_SYNC_INTERVAL_MINUTES", defaultMinutes: 60 }
  }
});
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OCCURRENCE_IN_PROGRESS_MESSAGE, closeEntityCommandSchema } from "@openrhen/contracts";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { resultFor } from "@/test/close-fixtures";
import { closeToastText } from "@/features/closed/close-commands";
import { closeToasts } from "@/features/closed/close-toast-store";
import { createSeedState, type PortalState, type StoredCommitment } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import { CommitmentDetail } from "./commitment-detail";

const now = new Date("2026-08-19T00:00:00.000Z");
freezeClock(now);

const pool = {
  id: "pool",
  name: "Pool",
  kind: "location" as const,
  status: "active" as const,
  pathways: [],
  portability: "fixed" as const,
  grants: [],
  channels: [],
  setupBeforeMinutes: 5,
  transitionAfterMinutes: 5,
  travelMinutes: 12,
  defaultRoutinePresetId: "kit"
};
const presets = [
  { id: "kit", name: "Pool kit", activityName: "Swim", status: "active" as const, steps: [] },
  { id: "court", name: "Court kit", activityName: "Tennis", status: "active" as const, steps: [] }
];
const step = {
  id: "pack",
  version: 3,
  commitmentId: "squad",
  title: "Pack towel",
  durationMinutes: 10,
  sequence: 0,
  timingRule: "contiguous" as const,
  energy: "low" as const,
  contexts: ["home"],
  dependencyIds: [],
  phase: "before" as const,
  status: "pending" as const,
  scheduledStartAt: "2026-08-19T05:00:00.000Z",
  scheduledEndAt: "2026-08-19T05:10:00.000Z"
};
const commitment: StoredCommitment = {
  id: "squad",
  version: 2,
  title: "Swim squad",
  startsAt: "2026-08-19T06:00:00.000Z",
  endsAt: "2026-08-19T07:00:00.000Z",
  status: "confirmed",
  location: "Pool",
  locationId: "pool",
  setupBeforeMinutes: 5,
  transitionAfterMinutes: 5,
  routineSource: "inherit",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z"
};

const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
const saveCommitmentRecurrenceRuleCommand = vi.fn().mockResolvedValue(undefined);
const recalculate = vi.fn().mockResolvedValue(undefined);
const saveActionCommand = vi.fn().mockResolvedValue(undefined);
const splitCommitmentSourceCommand = vi.fn().mockResolvedValue(undefined);
// Stands in for the server: a body the close route would refuse fails the test; the cascade is what the handler lists
// for a commitment (its prep actions and routine steps).
const closeEntityCommand = vi.fn(async (command: unknown) =>
  resultFor(closeEntityCommandSchema.parse(command), {
    version: 2,
    cascaded: [
      { type: "action", id: "prep-1", from: "planned", version: 4 },
      { type: "action", id: "prep-2", from: "planned", version: 4 },
      { type: "routine_step", id: "pack", from: "pending", version: 3 }
    ]
  })
);
let context: Record<string, unknown>;
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

function stateWith(overrides: Partial<StoredCommitment>, extra: Partial<PortalState> = {}): PortalState {
  const seed = createSeedState(now);
  return {
    ...seed,
    commitments: [{ ...commitment, ...overrides }],
    routineSteps: [step],
    routinePresets: presets,
    conditionDefinitions: [pool],
    settings: { ...seed.settings, timezone: "Australia/Sydney" },
    // Last, so a case can replace one of the lists above with the shape it is actually about.
    ...extra
  } as PortalState;
}

function show(overrides: Partial<StoredCommitment> = {}, extra: Partial<PortalState> = {}) {
  context = {
    state: stateWith(overrides, extra),
    ready: true,
    saving: false,
    saveEntityCommand,
    saveActionCommand,
    saveCommitmentRecurrenceRuleCommand,
    splitCommitmentSourceCommand,
    closeEntityCommand,
    recalculate
  };
  return render(<CommitmentDetail commitmentId="squad" />);
}

beforeEach(() => {
  saveEntityCommand.mockReset().mockResolvedValue(undefined);
  saveCommitmentRecurrenceRuleCommand.mockReset().mockResolvedValue(undefined);
  recalculate.mockClear();
  saveActionCommand.mockReset().mockResolvedValue(undefined);
  splitCommitmentSourceCommand.mockReset().mockResolvedValue(undefined);
  closeEntityCommand.mockClear();
  closeToasts.clear();
  vi.unstubAllGlobals();
});

describe("Commitment detail surface", () => {
  it("states what the commitment is, where it happens and where it came from", () => {
    show();
    expect(screen.getByRole("heading", { level: 1, name: "Swim squad" })).toBeTruthy();
    const place = screen.getByRole("heading", { name: "Place" }).closest("section")!;
    expect(place.textContent).toContain("Pool");
    expect(place.textContent).toContain("~12 min from home");
    expect(screen.getByText(/no import owns this record/i)).toBeTruthy();
    expect(screen.getByText(/Created/)).toBeTruthy();
  });

  it("says an imported commitment was imported, and points at the import history", () => {
    show({ sourceType: "example_sink", sourceTitle: "Family calendar" });
    expect(screen.getByText(/Imported from the Example Sink calendar/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See the import history" }).getAttribute("href")).toBe("/inbox/calendar");
  });

  it("lists the sources and sends Not the same event as a split at the version on screen", async () => {
    show({
      sources: [
        { id: "0f0e0d0c-0b0a-4908-8706-050403020100", provider: "example_daily", role: "primary" },
        { id: "1f0e0d0c-0b0a-4908-8706-050403020100", provider: "example_shared", role: "secondary" }
      ]
    });
    const sources = screen.getByRole("heading", { name: "Sources" }).closest("section")!;
    expect(sources.textContent).toContain("Example Daily");
    expect(sources.textContent).toContain("Example Shared");
    fireEvent.click(within(sources).getByRole("button", { name: "Not the same event" }));
    await vi.waitFor(() => expect(splitCommitmentSourceCommand).toHaveBeenCalledTimes(1));
    expect(splitCommitmentSourceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commitmentId: "squad",
        expectedVersion: 2,
        linkId: "1f0e0d0c-0b0a-4908-8706-050403020100"
      })
    );
  });

  it("says a commitment with no place can inherit nothing", () => {
    show({ locationId: undefined, location: undefined });
    const place = screen.getByRole("heading", { name: "Place" }).closest("section")!;
    expect(place.textContent).toContain("No place is linked");
  });

  const chips: [string, Partial<StoredCommitment>, string, string][] = [
    ["inherit that resolves", {}, "“Pool kit” · from Pool", "inherited"],
    ["a pinned preset", { routineSource: "preset", routinePresetId: "court" }, "“Court kit” · pinned", "pinned"],
    ["hand-shaped steps", { routineSource: "custom" }, "Customized", "customized"],
    ["a removed routine", { routineSource: "none" }, "Routine removed", "removed"]
  ];
  for (const [name, overrides, label, short] of chips)
    it(`chips ${name} as “${label}”`, () => {
      const { container } = show(overrides);
      const chip = container.querySelector(".provenance-chip")!;
      expect(chip.textContent).toBe(label);
      expect(chip.getAttribute("data-provenance")).toBe(short);
    });

  it("chips inherit with nothing to inherit as no routine", () => {
    const { container } = show({}, { conditionDefinitions: [{ ...pool, defaultRoutinePresetId: undefined }] });
    expect(container.querySelector(".provenance-chip")!.textContent).toBe("No routine (place has no default)");
  });

  it("offers the three sources, with the current one already chosen", () => {
    show({ routineSource: "none" });
    expect((screen.getByLabelText("Follow place default") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Remove routine") as HTMLInputElement).checked).toBe(true);
  });

  it("leaves a customized commitment with no source pre-chosen, since customized is not a choice", () => {
    show({ routineSource: "custom" });
    for (const label of ["Follow place default", "Use a different routine…", "Remove routine"])
      expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
  });

  it("removes the routine through the commitment command and recalculates so the steps go", async () => {
    show();
    fireEvent.click(screen.getByLabelText("Remove routine"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => expect(saveEntityCommand).toHaveBeenCalled());
    const command = saveEntityCommand.mock.calls[0]![0];
    expect(command.entityType).toBe("commitment");
    expect(command.expectedVersion).toBe(2);
    expect(command.entity).toMatchObject({
      id: "squad",
      title: "Swim squad",
      startsAt: commitment.startsAt,
      endsAt: commitment.endsAt,
      status: "confirmed",
      setupBeforeMinutes: 5,
      transitionAfterMinutes: 5,
      locationId: "pool",
      routineSource: "none"
    });
    expect(command.entity.routinePresetId).toBeUndefined();
    // The page asks the provider to recalculate rather than fetching itself, so `runCommand`'s
    // replay guard covers it and the returned state is adopted there.
    await vi.waitFor(() => expect(recalculate).toHaveBeenCalledTimes(1));
  });

  it("pins a chosen preset by id", async () => {
    show();
    fireEvent.click(screen.getByLabelText("Use a different routine…"));
    fireEvent.change(screen.getByLabelText("Routine to use"), { target: { value: "court" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => expect(saveEntityCommand).toHaveBeenCalled());
    expect(saveEntityCommand.mock.calls[0]![0].entity).toMatchObject({
      routineSource: "preset",
      routinePresetId: "court"
    });
  });

  it("refuses to pin nothing", async () => {
    show();
    fireEvent.click(screen.getByLabelText("Use a different routine…"));
    fireEvent.change(screen.getByLabelText("Routine to use"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(saveEntityCommand).not.toHaveBeenCalled();
  });

  it("lists the steps with their slot and status, and edits one through the routine_step command", async () => {
    show();
    const routine = screen.getByRole("heading", { name: "Routine" }).closest("section")!;
    expect(routine.textContent).toContain("Pack towel");
    expect(routine.textContent).toContain("10 min");
    expect(routine.textContent).toContain("pending");
    fireEvent.click(within(routine as HTMLElement).getByRole("button", { name: "Edit Pack towel" }));
    fireEvent.change(screen.getByLabelText("Duration minutes"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save step" }));
    await vi.waitFor(() => expect(saveEntityCommand).toHaveBeenCalled());
    const command = saveEntityCommand.mock.calls[0]![0];
    expect(command.entityType).toBe("routine_step");
    expect(command.expectedVersion).toBe(3);
    expect(command.entity).toMatchObject({
      id: "pack",
      commitmentId: "squad",
      title: "Pack towel",
      durationMinutes: 25,
      sequence: 0,
      contexts: ["home"],
      status: "pending"
    });
    // Nothing here claims the routine is now custom: the server decides that, and the chip follows.
    expect(command.entity.routineSource).toBeUndefined();
  });

  it("shows the flip to customized once the saved state comes back saying so", async () => {
    const { container, rerender } = show();
    expect(container.querySelector(".provenance-chip")!.textContent).toBe("“Pool kit” · from Pool");
    context = { ...context, state: stateWith({ routineSource: "custom" }) };
    rerender(<CommitmentDetail commitmentId="squad" />);
    expect(container.querySelector(".provenance-chip")!.textContent).toBe("Customized");
  });

  it("names the series and which occurrence this is, and opens the editor with Repeats on", () => {
    const rule = {
      id: "squad-rule",
      version: 1,
      title: "Squad",
      timezone: "Australia/Sydney",
      startDate: "2026-08-01",
      repeat: { unit: "days" as const, intervalDays: 7 },
      localStartTime: "16:00",
      localEndTime: "17:00",
      setupBeforeMinutes: 5,
      transitionAfterMinutes: 5,
      status: "active" as const
    };
    show({ recurrenceRuleId: "squad-rule", localDate: "2026-08-19" }, { commitmentRecurrenceRules: [rule] });
    const section = screen.getByRole("heading", { name: "Recurrence" }).closest("section")!;
    expect(section.textContent).toContain("every week");
    expect(section.textContent).toContain("16:00–17:00");
    expect(section.textContent).toContain("2026-08-19");
    fireEvent.click(within(section as HTMLElement).getByRole("button", { name: "Edit the series" }));
    const sheet = screen.getByRole("dialog", { name: "Edit recurring commitment" });
    expect((within(sheet).getByLabelText("Title") as HTMLInputElement).value).toBe("Squad");
    expect((within(sheet).getByLabelText("Repeats every (days)") as HTMLInputElement).value).toBe("7");
  });

  it("calls a one-off what it is, and edits it as itself", () => {
    show();
    expect(screen.getByRole("heading", { name: "Recurrence" }).closest("section")!.textContent).toContain(
      "A one-off commitment"
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const sheet = screen.getByRole("dialog", { name: "Edit commitment" });
    expect((within(sheet).getByLabelText("Title") as HTMLInputElement).value).toBe("Swim squad");
  });

  describe("cancelling", () => {
    const sam = {
      id: "sam",
      name: "Sam",
      kind: "contact" as const,
      status: "active" as const,
      pathways: [],
      portability: "portable" as const,
      grants: [],
      channels: []
    };

    it("offers one Cancel commitment button, and no Cancelled option in the status list", () => {
      show();
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const sheet = screen.getByRole("dialog", { name: "Edit commitment" });
      expect(within(sheet).getByRole("button", { name: /^Cancel commitment/ })).toBeTruthy();
      const select = within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Status" });
      expect(Array.from(select.options).map((option) => option.value)).toEqual(["confirmed", "tentative"]);
    });

    it("cancels through the close route, lists what went with it in the toast, and no longer asks about prep", async () => {
      show();
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const sheet = screen.getByRole("dialog", { name: "Edit commitment" });
      await act(async () => {
        fireEvent.click(within(sheet).getByRole("button", { name: /^Cancel commitment/ }));
      });
      expect(closeEntityCommand).toHaveBeenCalledOnce();
      expect(closeEntityCommandSchema.parse(closeEntityCommand.mock.calls[0]![0])).toMatchObject({
        type: "commitment",
        id: "squad",
        verb: "cancel",
        do: "close",
        expectedVersion: 2
      });
      expect(saveEntityCommand).not.toHaveBeenCalled();
      expect(saveActionCommand).not.toHaveBeenCalled();
      const toast = closeToasts.get();
      if (toast?.kind !== "closed") throw new Error("expected the close toast");
      expect(toast.title).toBe("Swim squad");
      expect(closeToastText("Swim squad", toast.closed)).toBe(
        "Swim squad cancelled, with 2 actions and 1 routine step."
      );
      // no contact to tell: the editor closes
      await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit commitment" })).toBeNull());
      expect(screen.queryByText(/open prep/)).toBeNull();
    });

    it("keeps the editor open for 'Cancelled. Let Sam know?' when the commitment has a contact", async () => {
      show({ contactId: "sam" } as never, { conditionDefinitions: [pool, sam] as never });
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const sheet = screen.getByRole("dialog", { name: "Edit commitment" });
      await act(async () => {
        fireEvent.click(within(sheet).getByRole("button", { name: /^Cancel commitment/ }));
      });
      const open = screen.getByRole("dialog", { name: "Edit commitment" });
      expect(within(open).getByText("Cancelled.")).toBeTruthy();
      expect(within(open).getByRole("button", { name: "Let Sam know?" })).toBeTruthy();
    });

    it("is disabled while the form holds unsaved edits", () => {
      show();
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const sheet = screen.getByRole("dialog", { name: "Edit commitment" });
      fireEvent.change(within(sheet).getByLabelText("Title"), { target: { value: "Swim squad (new)" } });
      expect((within(sheet).getByRole("button", { name: /^Cancel commitment/ }) as HTMLButtonElement).disabled).toBe(
        true
      );
    });

    it("shows a cancelled commitment's status as text with Restore, and no close button", () => {
      show({ status: "cancelled" });
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const sheet = screen.getByRole("dialog", { name: "Edit commitment" });
      expect(within(sheet).queryByRole("combobox", { name: "Status" })).toBeNull();
      expect(within(sheet).getByRole("button", { name: /^Restore/ })).toBeTruthy();
      expect(within(sheet).queryByRole("button", { name: /^Cancel commitment/ })).toBeNull();
    });

    it("has no cancel button on a series editor", () => {
      const rule = {
        id: "squad-rule",
        version: 1,
        title: "Squad",
        timezone: "Australia/Sydney",
        startDate: "2026-08-01",
        repeat: { unit: "days" as const, intervalDays: 7 },
        localStartTime: "16:00",
        localEndTime: "17:00",
        setupBeforeMinutes: 5,
        transitionAfterMinutes: 5,
        status: "active" as const
      };
      show({ recurrenceRuleId: "squad-rule", localDate: "2026-08-19" }, { commitmentRecurrenceRules: [rule] });
      const section = screen.getByRole("heading", { name: "Recurrence" }).closest("section")!;
      fireEvent.click(within(section as HTMLElement).getByRole("button", { name: "Edit the series" }));
      const sheet = screen.getByRole("dialog", { name: "Edit recurring commitment" });
      expect(within(sheet).queryByRole("button", { name: /^Cancel commitment/ })).toBeNull();
    });
  });

  it("saves the attendance and preferred location the editor was given", async () => {
    show({ attendance: "remote", preferredLocationId: "pool" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const sheet = screen.getByRole("dialog", { name: "Edit commitment" });
    expect((within(sheet).getByLabelText("Attendance") as HTMLSelectElement).value).toBe("remote");
    expect((within(sheet).getByLabelText("Preferred location") as HTMLSelectElement).value).toBe("pool");
    fireEvent.change(within(sheet).getByLabelText("Attendance"), { target: { value: "in_person" } });
    expect(within(sheet).queryByLabelText("Preferred location")).toBeNull();
    fireEvent.submit(sheet.querySelector("form")!);
    await vi.waitFor(() => expect(saveEntityCommand).toHaveBeenCalled());
    expect(saveEntityCommand.mock.calls[0]![0].entity).toMatchObject({
      attendance: "in_person",
      preferredLocationId: ""
    });
  });

  it("refuses a stale save when the commitment changed underneath an open sheet", async () => {
    const { rerender } = show();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    let sheet = screen.getByRole("dialog", { name: "Edit commitment" });
    expect(sheet).toBeTruthy();
    // A concurrent edit lands while the sheet is still open — the commitment is now at version 3.
    context = { ...context, state: stateWith({ version: 3 }) };
    rerender(<CommitmentDetail commitmentId="squad" />);
    // The mock behaves like the server's optimistic-concurrency check: it only accepts the version
    // that is actually current.
    saveEntityCommand.mockImplementation((command) =>
      command.entityType === "commitment" && command.expectedVersion === 3
        ? Promise.resolve()
        : Promise.reject(new Error("That commitment changed. Reload before editing."))
    );
    sheet = screen.getByRole("dialog", { name: "Edit commitment" });
    fireEvent.submit(sheet.querySelector("form")!);
    const alert = await within(sheet).findByRole("alert");
    expect(alert.textContent).toBe("That commitment changed. Reload before editing.");
    expect(screen.getByRole("dialog", { name: "Edit commitment" })).toBeTruthy();
  });

  it("says so when the id names nothing loaded", () => {
    context = {
      state: stateWith({}),
      ready: true,
      saving: false,
      saveEntityCommand,
      saveCommitmentRecurrenceRuleCommand,
      recalculate
    };
    render(<CommitmentDetail commitmentId="gone" />);
    expect(screen.getByRole("heading", { level: 1, name: "That commitment is not here." })).toBeTruthy();
  });

  it("shows when a commitment is shared with the family calendar", () => {
    show({ shareToCalendar: true, shareSource: "custom" });
    const section = screen.getByRole("heading", { name: "Family calendar" }).closest("section")!;
    expect(section.textContent).toContain("Shared with the family calendar");
    expect(section.textContent).toContain("set on this occurrence");
  });

  it("shows when sharing is inherited from the series", () => {
    const rule = {
      id: "squad-rule",
      version: 1,
      title: "Squad",
      timezone: "Australia/Sydney",
      startDate: "2026-08-01",
      repeat: { unit: "days" as const, intervalDays: 7 },
      localStartTime: "16:00",
      localEndTime: "17:00",
      setupBeforeMinutes: 5,
      transitionAfterMinutes: 5,
      status: "active" as const,
      shareToCalendar: true
    };
    show(
      { recurrenceRuleId: "squad-rule", localDate: "2026-08-19", shareToCalendar: true, shareSource: "inherit" },
      { commitmentRecurrenceRules: [rule] }
    );
    const section = screen.getByRole("heading", { name: "Family calendar" }).closest("section")!;
    expect(section.textContent).toContain("Shared with the family calendar");
    expect(section.textContent).toContain("from the series");
  });

  it("shows when a commitment is not shared with the family calendar", () => {
    show({ shareToCalendar: false });
    const section = screen.getByRole("heading", { name: "Family calendar" }).closest("section")!;
    expect(section.textContent).toContain("Not shared with the family calendar");
  });

  const squadRule = {
    id: "squad-rule",
    version: 1,
    title: "Squad",
    timezone: "Australia/Sydney",
    startDate: "2026-08-01",
    repeat: { unit: "days" as const, intervalDays: 7 },
    localStartTime: "16:00",
    localEndTime: "17:00",
    setupBeforeMinutes: 5,
    transitionAfterMinutes: 5,
    status: "active" as const
  };

  it("warns in the series editor when future dates of the series have their own changes", () => {
    const anchor: StoredCommitment = { ...commitment, recurrenceRuleId: "squad-rule", localDate: "2026-08-19" };
    const overridden: StoredCommitment = {
      ...commitment,
      id: "squad-26",
      recurrenceRuleId: "squad-rule",
      scheduleSource: "custom",
      startsAt: "2026-08-26T06:00:00.000Z",
      endsAt: "2026-08-26T07:00:00.000Z"
    };
    const past: StoredCommitment = {
      ...commitment,
      id: "squad-12",
      recurrenceRuleId: "squad-rule",
      scheduleSource: "custom",
      startsAt: "2026-08-12T06:00:00.000Z",
      endsAt: "2026-08-12T07:00:00.000Z"
    };
    show({}, { commitmentRecurrenceRules: [squadRule], commitments: [anchor, overridden, past] });
    fireEvent.click(
      within(screen.getByRole("heading", { name: "Recurrence" }).closest("section")!).getByRole("button", {
        name: "Edit the series"
      })
    );
    const sheet = screen.getByRole("dialog", { name: "Edit recurring commitment" });
    expect(sheet.textContent).toContain("1 date has its own changes and won't follow this edit.");
  });

  it("shows nothing when no future date of the series has its own changes", () => {
    show({ recurrenceRuleId: "squad-rule", localDate: "2026-08-19" }, { commitmentRecurrenceRules: [squadRule] });
    fireEvent.click(
      within(screen.getByRole("heading", { name: "Recurrence" }).closest("section")!).getByRole("button", {
        name: "Edit the series"
      })
    );
    const sheet = screen.getByRole("dialog", { name: "Edit recurring commitment" });
    expect(sheet.textContent).not.toContain("won't follow this edit");
  });

  it("asks whether to also change the occurrence in progress, and does not show the raw refusal", async () => {
    saveCommitmentRecurrenceRuleCommand.mockRejectedValueOnce(new Error(OCCURRENCE_IN_PROGRESS_MESSAGE));
    show({ recurrenceRuleId: "squad-rule", localDate: "2026-08-19" }, { commitmentRecurrenceRules: [squadRule] });
    fireEvent.click(
      within(screen.getByRole("heading", { name: "Recurrence" }).closest("section")!).getByRole("button", {
        name: "Edit the series"
      })
    );
    const sheet = screen.getByRole("dialog", { name: "Edit recurring commitment" });
    fireEvent.submit(sheet.querySelector("form")!);
    const question = await within(sheet).findByText("Also change the one happening now?");
    expect(question).toBeTruthy();
    expect(screen.queryByText(OCCURRENCE_IN_PROGRESS_MESSAGE)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("resubmits with applyToOccurrenceInProgress true when the reader says to change it too", async () => {
    saveCommitmentRecurrenceRuleCommand.mockRejectedValueOnce(new Error(OCCURRENCE_IN_PROGRESS_MESSAGE));
    show({ recurrenceRuleId: "squad-rule", localDate: "2026-08-19" }, { commitmentRecurrenceRules: [squadRule] });
    fireEvent.click(
      within(screen.getByRole("heading", { name: "Recurrence" }).closest("section")!).getByRole("button", {
        name: "Edit the series"
      })
    );
    const sheet = screen.getByRole("dialog", { name: "Edit recurring commitment" });
    fireEvent.submit(sheet.querySelector("form")!);
    await within(sheet).findByText("Also change the one happening now?");
    fireEvent.click(within(sheet).getByRole("button", { name: "Yes, change it too" }));
    await vi.waitFor(() => expect(saveCommitmentRecurrenceRuleCommand).toHaveBeenCalledTimes(2));
    expect(saveCommitmentRecurrenceRuleCommand.mock.calls[1]![0]).toMatchObject({
      applyToOccurrenceInProgress: true
    });
    await vi.waitFor(() => expect(screen.queryByText("Edit recurring commitment")).toBeNull());
  });

  it("resubmits with applyToOccurrenceInProgress false when the reader says to leave it", async () => {
    saveCommitmentRecurrenceRuleCommand.mockRejectedValueOnce(new Error(OCCURRENCE_IN_PROGRESS_MESSAGE));
    show({ recurrenceRuleId: "squad-rule", localDate: "2026-08-19" }, { commitmentRecurrenceRules: [squadRule] });
    fireEvent.click(
      within(screen.getByRole("heading", { name: "Recurrence" }).closest("section")!).getByRole("button", {
        name: "Edit the series"
      })
    );
    const sheet = screen.getByRole("dialog", { name: "Edit recurring commitment" });
    fireEvent.submit(sheet.querySelector("form")!);
    await within(sheet).findByText("Also change the one happening now?");
    fireEvent.click(within(sheet).getByRole("button", { name: "No, leave it as it is" }));
    await vi.waitFor(() => expect(saveCommitmentRecurrenceRuleCommand).toHaveBeenCalledTimes(2));
    expect(saveCommitmentRecurrenceRuleCommand.mock.calls[1]![0]).toMatchObject({
      applyToOccurrenceInProgress: false
    });
  });

  it("cancelling the in-progress question leaves the editor open without saving", async () => {
    saveCommitmentRecurrenceRuleCommand.mockRejectedValueOnce(new Error(OCCURRENCE_IN_PROGRESS_MESSAGE));
    show({ recurrenceRuleId: "squad-rule", localDate: "2026-08-19" }, { commitmentRecurrenceRules: [squadRule] });
    fireEvent.click(
      within(screen.getByRole("heading", { name: "Recurrence" }).closest("section")!).getByRole("button", {
        name: "Edit the series"
      })
    );
    const sheet = screen.getByRole("dialog", { name: "Edit recurring commitment" });
    fireEvent.submit(sheet.querySelector("form")!);
    await within(sheet).findByText("Also change the one happening now?");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Also change the one happening now?")).toBeNull();
    expect(saveCommitmentRecurrenceRuleCommand).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Edit recurring commitment" })).toBeTruthy();
  });

  it("shows an overridden occurrence as changed for this date, and Use the series reverts it", async () => {
    show({ recurrenceRuleId: "squad-rule", scheduleSource: "custom" }, { commitmentRecurrenceRules: [squadRule] });
    expect(screen.getByRole("heading", { name: "Changed for this date" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use the series" }));
    await vi.waitFor(() => expect(saveEntityCommand).toHaveBeenCalled());
    const command = saveEntityCommand.mock.calls[0]![0];
    expect(command.entityType).toBe("commitment");
    expect(command.expectedVersion).toBe(2);
    expect(command.entity).toMatchObject({ id: "squad", scheduleSource: "inherit" });
    await vi.waitFor(() => expect(recalculate).toHaveBeenCalledTimes(1));
  });

  it("shows nothing for an occurrence that still tracks its series", () => {
    show({ recurrenceRuleId: "squad-rule" }, { commitmentRecurrenceRules: [squadRule] });
    expect(screen.queryByRole("heading", { name: "Changed for this date" })).toBeNull();
  });

  // The flag for a commitment the projection could give no journey figure at all
  // read off the latest stored
  // timeline.
  function withTimeline(travelGap: "no_place" | "no_estimate") {
    return {
      planning: {
        status: "current" as const,
        result: { derivedState: { commitmentTimelines: [{ id: "squad", travelGap }] } }
      }
    };
  }

  it("offers to set a place when travel can't be planned for a free-text location", () => {
    show({}, withTimeline("no_place") as Partial<PortalState>);
    expect(screen.getByText(/No place set — travel can’t be planned\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set it?" }));
    expect(screen.getByRole("dialog", { name: "Edit commitment" })).toBeTruthy();
  });

  it("says a located place has no travel figure yet", () => {
    show({}, withTimeline("no_estimate") as Partial<PortalState>);
    expect(screen.getByText(/no travel figure yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set it?" })).toBeNull();
  });

  it("shows no travel notice once a journey is resolved", () => {
    show();
    expect(screen.queryByText(/travel can’t be planned/)).toBeNull();
    expect(screen.queryByText(/no travel figure yet/)).toBeNull();
  });
});
