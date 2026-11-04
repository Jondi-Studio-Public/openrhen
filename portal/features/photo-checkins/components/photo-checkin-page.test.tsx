// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhotoCheckinWire } from "@openrhen/contracts";
import { waitFor } from "@testing-library/react";
import { fireEvent, render, screen } from "@/test/render";

const client = vi.hoisted(() => ({
  fetchPhotoCheckins: vi.fn(),
  setPhotoCheckinMode: vi.fn(),
  uploadPhotoCheckin: vi.fn(),
  editPhotoDescription: vi.fn()
}));
vi.mock("@/features/photo-checkins/photo-checkin-client", () => client);

const checkInCommand = vi.hoisted(() => ({ answerOnTrack: vi.fn() }));
vi.mock("@/features/check-in/check-in-command", () => checkInCommand);
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const portal = vi.hoisted(() => ({
  pendingCheckIn: null as null | { id: string; version: number },
  dismissPendingCheckIn: vi.fn()
}));
vi.mock("@/state/portal-provider", () => ({ usePortal: () => portal }));

const { PhotoCheckinPage } = await import("./photo-checkin-page");

const photo = (overrides: Partial<PhotoCheckinWire> = {}): PhotoCheckinWire => ({
  id: "11111111-1111-4111-8111-111111111111",
  takenAt: "2026-10-02T03:00:00.000Z",
  checkInId: null,
  directiveTitle: null,
  transcript: "At my desk",
  description: "At my desk",
  editedByUser: false,
  vlmDescription: null,
  agreement: null,
  status: "pending",
  statusDetail: null,
  originalType: "image/jpeg",
  originalBytes: 100,
  version: 1,
  ...overrides
});

beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  checkInCommand.answerOnTrack.mockReset();
  push.mockReset();
  portal.dismissPendingCheckIn.mockReset();
  portal.pendingCheckIn = null;
  window.history.replaceState(null, "", "/photo-checkins");
  client.fetchPhotoCheckins.mockResolvedValue({ mode: "off", photos: [] });
});

describe("the photo check-in page", () => {
  it("offers no capture form while off, and says so", async () => {
    render(<PhotoCheckinPage />);
    expect(await screen.findByText(/Photo check-ins are off/)).toBeTruthy();
    expect(screen.queryByText("Save check-in")).toBeNull();
  });

  it("changes the mode only when the person picks one", async () => {
    client.setPhotoCheckinMode.mockResolvedValue(undefined);
    render(<PhotoCheckinPage />);
    const select = (await screen.findByLabelText("Photo check-in mode")) as HTMLSelectElement;
    expect(client.setPhotoCheckinMode).not.toHaveBeenCalled();
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    fireEvent.change(select, { target: { value: "on" } });
    await waitFor(() => expect(client.setPhotoCheckinMode).toHaveBeenCalledWith("on"));
    expect(await screen.findByText("Save check-in")).toBeTruthy();
  });

  it("uploads the chosen photo with what was said and clears the form", async () => {
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    client.uploadPhotoCheckin.mockResolvedValue({ photo: photo(), duplicate: false });
    render(<PhotoCheckinPage />);
    const file = new File([Uint8Array.from([0xff, 0xd8, 0xff])], "p.jpg", { type: "image/jpeg" });
    fireEvent.change(await screen.findByLabelText("Photo"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("What are you doing?"), { target: { value: "  At my desk  " } });
    fireEvent.click(screen.getByText("Save check-in"));
    await waitFor(() => expect(client.uploadPhotoCheckin).toHaveBeenCalledTimes(1));
    expect(client.uploadPhotoCheckin.mock.calls[0]![0]).toMatchObject({ photo: file, transcript: "At my desk" });
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect((screen.getByLabelText("What are you doing?") as HTMLTextAreaElement).value).toBe("");
  });

  async function savePhotoView() {
    const view = render(<PhotoCheckinPage />);
    fireEvent.change(await screen.findByLabelText("Photo"), {
      target: { files: [new File(["x"], "p.jpg", { type: "image/jpeg" })] }
    });
    fireEvent.click(screen.getByText("Save check-in"));
    return view;
  }
  async function savePhoto() {
    await savePhotoView();
  }

  it("answers the open check-in as on track when the photo is saved against it, then returns to Now", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    window.history.replaceState(null, "", `/photo-checkins?checkIn=${id}`);
    portal.pendingCheckIn = { id, version: 5 };
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    client.uploadPhotoCheckin.mockResolvedValue({ photo: photo({ checkInId: id }), duplicate: false });
    checkInCommand.answerOnTrack.mockResolvedValue(undefined);
    await savePhoto();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(checkInCommand.answerOnTrack).toHaveBeenCalledWith(id, 5, "sheet");
    expect(portal.dismissPendingCheckIn).toHaveBeenCalledWith(id);
  });

  it("answers by the id in the link, with no version, when the first check-in poll has not landed", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    window.history.replaceState(null, "", `/photo-checkins?checkIn=${id}`);
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    client.uploadPhotoCheckin.mockResolvedValue({ photo: photo({ checkInId: id }), duplicate: false });
    checkInCommand.answerOnTrack.mockResolvedValue(undefined);
    await savePhoto();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(checkInCommand.answerOnTrack).toHaveBeenCalledWith(id, null, "sheet");
  });

  it("answers the check-in it started from when a duplicate photo comes back filed against another", async () => {
    const b = "22222222-2222-4222-8222-222222222222";
    const a = "44444444-4444-4444-8444-444444444444";
    window.history.replaceState(null, "", `/photo-checkins?checkIn=${b}`);
    portal.pendingCheckIn = { id: b, version: 3 };
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    client.uploadPhotoCheckin.mockResolvedValue({ photo: photo({ checkInId: a }), duplicate: true });
    checkInCommand.answerOnTrack.mockResolvedValue(undefined);
    await savePhoto();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(checkInCommand.answerOnTrack).toHaveBeenCalledTimes(1);
    expect(checkInCommand.answerOnTrack).toHaveBeenCalledWith(b, 3, "sheet");
  });

  it("does not answer or navigate when the page is left before the upload finishes", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    window.history.replaceState(null, "", `/photo-checkins?checkIn=${id}`);
    portal.pendingCheckIn = { id, version: 5 };
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    let finish: (value: unknown) => void = () => {};
    client.uploadPhotoCheckin.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const view = await savePhotoView();
    await waitFor(() => expect(client.uploadPhotoCheckin).toHaveBeenCalledTimes(1));
    view.unmount();
    finish({ photo: photo({ checkInId: id }), duplicate: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(checkInCommand.answerOnTrack).not.toHaveBeenCalled();
    expect(portal.dismissPendingCheckIn).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("does not navigate when the page is left while the answer is being sent", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    window.history.replaceState(null, "", `/photo-checkins?checkIn=${id}`);
    portal.pendingCheckIn = { id, version: 5 };
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    client.uploadPhotoCheckin.mockResolvedValue({ photo: photo({ checkInId: id }), duplicate: false });
    let answered: () => void = () => {};
    checkInCommand.answerOnTrack.mockReturnValue(new Promise<void>((resolve) => (answered = resolve)));
    const view = await savePhotoView();
    await waitFor(() => expect(checkInCommand.answerOnTrack).toHaveBeenCalledTimes(1));
    view.unmount();
    answered();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(portal.dismissPendingCheckIn).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("leaves a different open check-in alone", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    window.history.replaceState(null, "", `/photo-checkins?checkIn=${id}`);
    portal.pendingCheckIn = { id: "33333333-3333-4333-8333-333333333333", version: 2 };
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    client.uploadPhotoCheckin.mockResolvedValue({ photo: photo({ checkInId: id }), duplicate: false });
    await savePhoto();
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(checkInCommand.answerOnTrack).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the photo and stays put when the server says the check-in was already answered", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    window.history.replaceState(null, "", `/photo-checkins?checkIn=${id}`);
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    client.uploadPhotoCheckin.mockResolvedValue({ photo: photo({ checkInId: id }), duplicate: false });
    checkInCommand.answerOnTrack.mockRejectedValue(new Error("This check-in is already answered."));
    await savePhoto();
    expect(
      await screen.findByText(/Saved\. The check-in was not answered: This check-in is already answered/)
    ).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("says so, and stays, when the check-in cannot be answered", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    window.history.replaceState(null, "", `/photo-checkins?checkIn=${id}`);
    portal.pendingCheckIn = { id, version: 5 };
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    client.uploadPhotoCheckin.mockResolvedValue({ photo: photo({ checkInId: id }), duplicate: false });
    checkInCommand.answerOnTrack.mockRejectedValue(new Error("This check-in changed. Reload and try again."));
    await savePhoto();
    expect(await screen.findByText(/The check-in was not answered: This check-in changed/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    expect(portal.dismissPendingCheckIn).not.toHaveBeenCalled();
  });

  it("leaves Now alone for a photo sent with no check-in", async () => {
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    client.uploadPhotoCheckin.mockResolvedValue({ photo: photo(), duplicate: false });
    await savePhoto();
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(checkInCommand.answerOnTrack).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the form and shows the refusal when a save fails", async () => {
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    client.uploadPhotoCheckin.mockRejectedValue(new Error("That file is not a supported photo."));
    render(<PhotoCheckinPage />);
    fireEvent.change(await screen.findByLabelText("Photo"), {
      target: { files: [new File(["x"], "p.jpg", { type: "image/jpeg" })] }
    });
    fireEvent.click(screen.getByText("Save check-in"));
    expect((await screen.findByRole("alert")).textContent).toBe("That file is not a supported photo.");
  });

  it("shows the trail with the plan's wording and saves an edited description with its version", async () => {
    client.fetchPhotoCheckins.mockResolvedValue({
      mode: "on",
      photos: [photo({ directiveTitle: "Study maths", vlmDescription: "a desk with a laptop", version: 3 })]
    });
    client.editPhotoDescription.mockResolvedValue(photo({ description: "Maths at my desk", version: 4 }));
    render(<PhotoCheckinPage />);
    expect(await screen.findByText(/The plan said: Study maths/)).toBeTruthy();
    expect(screen.getByText(/What the pipeline saw: a desk with a laptop/)).toBeTruthy();
    const save = screen.getByText("Save description") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your description"), { target: { value: "Maths at my desk" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(client.editPhotoDescription).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        "Maths at my desk",
        3
      )
    );
  });

  it("says when the trail could not be loaded and offers another try", async () => {
    client.fetchPhotoCheckins.mockRejectedValueOnce(new Error("The photo check-ins could not be loaded."));
    render(<PhotoCheckinPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
    client.fetchPhotoCheckins.mockResolvedValue({ mode: "on", photos: [] });
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("No photos yet.")).toBeTruthy();
  });
});
