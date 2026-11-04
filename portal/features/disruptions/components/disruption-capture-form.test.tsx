// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import { fireEvent, render, screen } from "@/test/render";
import { DisruptionCaptureForm } from "./disruption-capture-form";

const now = new Date("2026-08-30T04:00:00.000Z");
const state = createSeedState(now);
freezeClock(now);

const runningSession = {
  id: "session-1",
  actionId: "action-1",
  status: "running",
  targetType: "deliverable",
  targetTitle: "Writing the quarterly report",
  startedAt: now.toISOString(),
  plannedEndAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  plannedMinutes: 30,
  remainingBeforeMinutes: 30,
  activeElapsedSeconds: 0
} as unknown as PortalState["activeSession"];

describe("DisruptionCaptureForm", () => {
  /** The fast path, whole: the only thing typed is what happened, and everything else defaults. */
  it("saves one confirmed commitment from a title alone", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <DisruptionCaptureForm
        state={state}
        saveEntityCommand={saveEntityCommand}
        runActivityCommand={runActivityCommand}
      />
    );
    fireEvent.change(screen.getByLabelText("What came up"), { target: { value: "Called out to Wangaratta" } });
    fireEvent.click(screen.getByRole("button", { name: "It's happening" }));
    await vi.waitFor(() => expect(saveEntityCommand).toHaveBeenCalledTimes(1));
    expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({
      entityType: "commitment",
      entity: {
        title: "Called out to Wangaratta",
        status: "confirmed",
        origin: "disruption",
        disruptionSource: "other",
        disruptionOpenEnded: false,
        startsAt: "2026-08-30T04:00:00.000Z",
        endsAt: "2026-08-30T05:00:00.000Z"
      }
    });
  });

  it("asks for the time when the reader reaches back, and calls saving it logging", () => {
    render(<DisruptionCaptureForm state={state} saveEntityCommand={vi.fn()} runActivityCommand={vi.fn()} />);
    expect(screen.queryByLabelText("What time it started")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Earlier today" }));
    expect((screen.getByLabelText("What time it started") as HTMLInputElement).value).toBe("14:00");
    expect(screen.getByRole("button", { name: "Log it" })).toBeTruthy();
  });

  it("says why nothing was saved and keeps what was typed", async () => {
    const saveEntityCommand = vi.fn();
    render(<DisruptionCaptureForm state={state} saveEntityCommand={saveEntityCommand} runActivityCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "It's happening" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("A disruption needs a name."));
    expect(saveEntityCommand).not.toHaveBeenCalled();
  });

  /**
   * A disruption logged as happening now used to leave the Now page saying
   * "commitment in progress" with a Start button still waiting to be pressed. Saving one live, with
   * the checkbox on (the default), now starts tracking on it in the same breath.
   */
  it("starts tracking a live disruption after saving it, by default", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <DisruptionCaptureForm
        state={state}
        saveEntityCommand={saveEntityCommand}
        runActivityCommand={runActivityCommand}
      />
    );
    expect(screen.getByLabelText("Track time on it")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What came up"), { target: { value: "Called out to Wangaratta" } });
    fireEvent.click(screen.getByRole("button", { name: "It's happening" }));
    await vi.waitFor(() => expect(runActivityCommand).toHaveBeenCalledTimes(1));
    expect(runActivityCommand.mock.calls[0]![0]).toMatchObject({
      type: "start_activity",
      targetType: "fixed_commitment",
      phase: "active",
      expectedVersion: 1,
      plannedMinutes: 60
    });
  });

  it("does not offer the checkbox, or start tracking, for a disruption logged for later", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <DisruptionCaptureForm
        state={state}
        saveEntityCommand={saveEntityCommand}
        runActivityCommand={runActivityCommand}
      />
    );
    fireEvent.change(screen.getByLabelText("What came up"), { target: { value: "School called" } });
    fireEvent.click(screen.getByRole("button", { name: "+60m" }));
    expect(screen.queryByLabelText("Track time on it")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "It's happening" }));
    await vi.waitFor(() => expect(saveEntityCommand).toHaveBeenCalledTimes(1));
    expect(runActivityCommand).not.toHaveBeenCalled();
  });

  it("sends only the save when the checkbox is unticked", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <DisruptionCaptureForm
        state={state}
        saveEntityCommand={saveEntityCommand}
        runActivityCommand={runActivityCommand}
      />
    );
    fireEvent.change(screen.getByLabelText("What came up"), { target: { value: "Called out to Wangaratta" } });
    fireEvent.click(screen.getByLabelText("Track time on it"));
    fireEvent.click(screen.getByRole("button", { name: "It's happening" }));
    await vi.waitFor(() => expect(saveEntityCommand).toHaveBeenCalledTimes(1));
    expect(runActivityCommand).not.toHaveBeenCalled();
  });

  /**
   * The server refuses a second concurrent session outright (activity-commands.ts). Rather than send
   * a command doomed to fail, the box is shown unchecked and disabled, naming what is already running.
   */
  it("disables the checkbox and names the running session when one is already open", async () => {
    const runningState = { ...state, activeSession: runningSession };
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <DisruptionCaptureForm
        state={runningState}
        saveEntityCommand={saveEntityCommand}
        runActivityCommand={runActivityCommand}
      />
    );
    const checkbox = screen.getByLabelText("Track time on it") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByText(/Finish Writing the quarterly report first/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What came up"), { target: { value: "Called out to Wangaratta" } });
    fireEvent.click(screen.getByRole("button", { name: "It's happening" }));
    await vi.waitFor(() => expect(saveEntityCommand).toHaveBeenCalledTimes(1));
    expect(runActivityCommand).not.toHaveBeenCalled();
  });

  it("reports a tracking failure but still treats the disruption as saved", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const runActivityCommand = vi.fn().mockRejectedValue(new Error("Another activity is already open."));
    const onSaved = vi.fn();
    render(
      <DisruptionCaptureForm
        state={state}
        saveEntityCommand={saveEntityCommand}
        runActivityCommand={runActivityCommand}
        onSaved={onSaved}
      />
    );
    fireEvent.change(screen.getByLabelText("What came up"), { target: { value: "Called out to Wangaratta" } });
    fireEvent.click(screen.getByRole("button", { name: "It's happening" }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // onSaved runs before React commits the error, so wait for the alert to render too.
    expect((await screen.findByRole("alert")).textContent).toContain("Another activity is already open.");
  });

  const withSam = {
    ...state,
    conditionDefinitions: [
      ...state.conditionDefinitions,
      { id: "sam", name: "Sam", kind: "contact", status: "active", channels: [] }
    ]
  } as unknown as PortalState;

  it("shows neither the about line nor the honest line without a preset", () => {
    render(<DisruptionCaptureForm state={withSam} saveEntityCommand={vi.fn()} runActivityCommand={vi.fn()} />);
    expect(screen.queryByText(/^About /)).toBeNull();
    expect(screen.queryByText(/doesn.t message/)).toBeNull();
  });

  it("shows the about line and the honest line with a preset naming a resolvable contact", () => {
    render(
      <DisruptionCaptureForm
        state={withSam}
        saveEntityCommand={vi.fn()}
        runActivityCommand={vi.fn()}
        preset={{ contactId: "sam", about: "Dentist at 10:00" }}
      />
    );
    expect(screen.getByText("About Dentist at 10:00")).toBeTruthy();
    expect(
      screen.getByText(/OpenRhen doesn’t message Sam\. Tell them yourself, or add their phone or email/)
    ).toBeTruthy();
    expect((screen.getByLabelText("Who's affected?") as HTMLSelectElement).value).toBe("sam");
    expect(screen.queryByRole("link", { name: "Text Sam" })).toBeNull();
  });

  /** The contact messages design note: the message is drafted from why the offer was made, and handed over as links. */
  it("drafts the message and offers Text and Email links when the contact has a phone and an email", () => {
    const reachable = {
      ...state,
      conditionDefinitions: [
        ...state.conditionDefinitions,
        {
          id: "sam",
          name: "Sam Lee",
          kind: "contact",
          status: "active",
          channels: [],
          phone: "0400 123 456",
          email: "sam@example.com"
        }
      ]
    } as unknown as PortalState;
    render(
      <DisruptionCaptureForm
        state={reachable}
        saveEntityCommand={vi.fn()}
        runActivityCommand={vi.fn()}
        preset={{ contactId: "sam", about: "Dentist at 10:00", reason: "late", lateMinutes: 12 }}
      />
    );
    const message = screen.getByLabelText("Message to Sam Lee") as HTMLTextAreaElement;
    expect(message.value).toBe("Hi Sam, I'm running about 12 min late for Dentist at 10:00.");
    fireEvent.change(message, { target: { value: "Ten minutes late, sorry!" } });
    expect(screen.getByRole("link", { name: "Text Sam Lee" }).getAttribute("href")).toBe(
      "sms:0400123456?&body=Ten%20minutes%20late%2C%20sorry!"
    );
    expect(screen.getByRole("link", { name: "Email Sam Lee" }).getAttribute("href")).toBe(
      "mailto:sam@example.com?subject=Running%20late%3A%20Dentist%20at%2010%3A00&body=Ten%20minutes%20late%2C%20sorry!"
    );
    expect(screen.getByText(/OpenRhen doesn’t send this/)).toBeTruthy();
  });

  it("starts a fresh draft addressed to whoever is picked instead", () => {
    const two = {
      ...state,
      conditionDefinitions: [
        ...state.conditionDefinitions,
        { id: "sam", name: "Sam", kind: "contact", status: "active", channels: [], phone: "0400123456" },
        { id: "alex", name: "Alex", kind: "contact", status: "active", channels: [], email: "alex@example.com" }
      ]
    } as unknown as PortalState;
    render(
      <DisruptionCaptureForm
        state={two}
        saveEntityCommand={vi.fn()}
        runActivityCommand={vi.fn()}
        preset={{ contactId: "sam", about: "Dentist at 10:00", reason: "cancelled" }}
      />
    );
    expect((screen.getByLabelText("Message to Sam") as HTMLTextAreaElement).value).toContain("Hi Sam,");
    fireEvent.change(screen.getByLabelText("Who's affected?"), { target: { value: "alex" } });
    expect((screen.getByLabelText("Message to Alex") as HTMLTextAreaElement).value).toBe(
      "Hi Alex, I have to cancel Dentist at 10:00. Sorry about that."
    );
    expect(screen.queryByRole("link", { name: /^Text/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Email Alex" })).toBeTruthy();
  });

  const withSamAndAlex = {
    ...state,
    conditionDefinitions: [
      ...state.conditionDefinitions,
      { id: "sam", name: "Sam", kind: "contact", status: "active", channels: [] },
      { id: "alex", name: "Alex", kind: "contact", status: "active", channels: [] }
    ]
  } as unknown as PortalState;

  /**
   * `app-shell.tsx` does not remount this form on every open — only on close, or on switching away
   * from the disruption half and back — so a second **Let … know?** offer clicked while the sheet is
   * already open in this mode reaches the form as nothing but a new `preset` prop on the same mounted
   * instance. The draft is seeded from `preset` only once, in `useState`'s initializer, so without a
   * `key` tied to the preset the form would keep the first offer's contact and About line. This
   * mirrors `app-shell.tsx`'s own keying (`${contactId}:${about}`) to prove that scheme actually forces
   * the remount a bare prop change would not.
   */
  it("does not keep the previous offer's contact when a differently-keyed preset replaces it", () => {
    const keyFor = (preset: { contactId?: string; about?: string }) =>
      `${preset.contactId ?? ""}:${preset.about ?? ""}`;
    const first = { contactId: "sam", about: "Dentist at 10:00" };
    const { rerender } = render(
      <DisruptionCaptureForm
        key={keyFor(first)}
        state={withSamAndAlex}
        saveEntityCommand={vi.fn()}
        runActivityCommand={vi.fn()}
        preset={first}
      />
    );
    expect((screen.getByLabelText("Who's affected?") as HTMLSelectElement).value).toBe("sam");
    expect(screen.getByText("About Dentist at 10:00")).toBeTruthy();

    const second = { contactId: "alex", about: "Standup at 09:00" };
    rerender(
      <DisruptionCaptureForm
        key={keyFor(second)}
        state={withSamAndAlex}
        saveEntityCommand={vi.fn()}
        runActivityCommand={vi.fn()}
        preset={second}
      />
    );
    expect((screen.getByLabelText("Who's affected?") as HTMLSelectElement).value).toBe("alex");
    expect(screen.getByText("About Standup at 09:00")).toBeTruthy();
    expect(screen.queryByText("About Dentist at 10:00")).toBeNull();
  });

  it("sends the contact on save, and omits it when none is chosen", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <DisruptionCaptureForm
        state={withSam}
        saveEntityCommand={saveEntityCommand}
        runActivityCommand={vi.fn()}
        preset={{ contactId: "sam" }}
      />
    );
    fireEvent.change(screen.getByLabelText("What came up"), { target: { value: "Called out to Wangaratta" } });
    fireEvent.click(screen.getByRole("button", { name: "It's happening" }));
    await vi.waitFor(() => expect(saveEntityCommand).toHaveBeenCalledTimes(1));
    expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({ entity: { contactId: "sam" } });
  });
});
