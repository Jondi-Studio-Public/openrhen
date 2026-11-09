// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { ReasonTagsCard } from "./reason-tags-card";

const client = vi.hoisted(() => ({ fetchReasonTags: vi.fn(), putReasonTags: vi.fn(), deleteReasonAndTags: vi.fn() }));
vi.mock("@/features/check-in/reason-tag-client", () => client);

const ID = "11111111-1111-4111-8111-111111111111";
const view = (over: Record<string, unknown> = {}) => ({
  checkInId: ID,
  text: "the kettle was loud",
  savedAt: "2026-11-09T10:00:00.000Z",
  tags: ["kettle noise", "outside"],
  origin: "inferred",
  stale: false,
  ...over
});

beforeEach(() => {
  client.fetchReasonTags.mockReset();
  client.putReasonTags.mockReset();
  client.deleteReasonAndTags.mockReset();
});

describe("ReasonTagsCard", () => {
  it("shows nothing until there is a reason", async () => {
    client.fetchReasonTags.mockResolvedValue({ modelConfigured: true, reasons: [] });
    const empty = render(<ReasonTagsCard />);
    await waitFor(() => expect(client.fetchReasonTags).toHaveBeenCalled());
    expect(empty.container.textContent).toBe("");
    empty.unmount();
  });

  it("says the list could not be loaded, with a retry that loads it", async () => {
    client.fetchReasonTags.mockRejectedValueOnce(new Error("Could not reach the portal. Try again."));
    render(<ReasonTagsCard />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the portal. Try again.");
    client.fetchReasonTags.mockResolvedValue({ modelConfigured: true, reasons: [view()] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    await screen.findByText("the kettle was loud");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows each reason with its words, its inferred tags and where they came from", async () => {
    client.fetchReasonTags.mockResolvedValue({ modelConfigured: true, reasons: [view()] });
    render(<ReasonTagsCard />);
    await screen.findByText("the kettle was loud");
    expect(screen.getByText("kettle noise")).toBeTruthy();
    expect(screen.getByText("outside")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Inferred");
  });

  it("says why a reason has no tags", async () => {
    client.fetchReasonTags.mockResolvedValue({
      modelConfigured: false,
      reasons: [view({ tags: [], origin: null })]
    });
    render(<ReasonTagsCard />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("No tags (no local model is set)"));
  });

  it("removes a tag by saving the rest as the owner's answer, under a fresh request id", async () => {
    client.fetchReasonTags.mockResolvedValue({ modelConfigured: true, reasons: [view()] });
    client.putReasonTags.mockResolvedValue(view({ tags: ["outside"], origin: "corrected" }));
    render(<ReasonTagsCard />);
    await screen.findByText("kettle noise");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove tag kettle noise" }));
    });
    expect(client.putReasonTags).toHaveBeenCalledWith(
      ID,
      { tags: ["outside"] },
      expect.stringMatching(/^[0-9a-f-]{36}$/)
    );
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Your answer"));
    expect(screen.queryByText("kettle noise")).toBeNull();
  });

  it("adds a tag in free text, with no list to pick from and nothing suggested", async () => {
    client.fetchReasonTags.mockResolvedValue({ modelConfigured: true, reasons: [view()] });
    client.putReasonTags.mockResolvedValue(
      view({ tags: ["kettle noise", "outside", "my own words"], origin: "corrected" })
    );
    render(<ReasonTagsCard />);
    const input = (await screen.findByLabelText("Add a tag")) as HTMLInputElement;
    expect(input.getAttribute("list")).toBeNull();
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(document.querySelector("datalist, select, [role=listbox]")).toBeNull();
    fireEvent.change(input, { target: { value: "  my own words " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(client.putReasonTags).toHaveBeenCalledWith(
      ID,
      { tags: ["kettle noise", "outside", "my own words"] },
      expect.any(String)
    );
    await screen.findByText("my own words");
    expect((screen.getByLabelText("Add a tag") as HTMLInputElement).value).toBe("");
  });

  it("will not add a blank tag", async () => {
    client.fetchReasonTags.mockResolvedValue({ modelConfigured: true, reasons: [view()] });
    render(<ReasonTagsCard />);
    await screen.findByLabelText("Add a tag");
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Add a tag"), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers Reset only on the owner's own answer, and shows the model's tags again after it", async () => {
    client.fetchReasonTags.mockResolvedValue({
      modelConfigured: true,
      reasons: [view({ tags: ["mine"], origin: "corrected" })]
    });
    client.putReasonTags.mockResolvedValue(view());
    render(<ReasonTagsCard />);
    const reset = await screen.findByRole("button", { name: "Reset" });
    await act(async () => {
      fireEvent.click(reset);
    });
    expect(client.putReasonTags).toHaveBeenCalledWith(ID, { reset: true }, expect.any(String));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Inferred"));
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("deletes the reason and its tags only after a second tap", async () => {
    client.fetchReasonTags.mockResolvedValue({ modelConfigured: true, reasons: [view()] });
    client.deleteReasonAndTags.mockResolvedValue(undefined);
    render(<ReasonTagsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(client.deleteReasonAndTags).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete reason and tags" }));
    });
    expect(client.deleteReasonAndTags).toHaveBeenCalledWith(ID);
    await waitFor(() => expect(screen.queryByText("the kettle was loud")).toBeNull());
  });

  it("shows a failed save as an alert and keeps the tags as they were", async () => {
    client.fetchReasonTags.mockResolvedValue({ modelConfigured: true, reasons: [view()] });
    client.putReasonTags.mockRejectedValue(new Error("Could not reach the portal. Try again."));
    render(<ReasonTagsCard />);
    const remove = await screen.findByRole("button", { name: "Remove tag outside" });
    await act(async () => {
      fireEvent.click(remove);
    });
    expect((await screen.findByRole("alert")).textContent).toBe("Could not reach the portal. Try again.");
    expect(screen.getByText("outside")).toBeTruthy();
  });

  it("folds all but the first five behind Show all", async () => {
    const many = Array.from({ length: 7 }, (_, n) =>
      view({ checkInId: `11111111-1111-4111-8111-11111111111${n}`, text: `words number ${n}` })
    );
    client.fetchReasonTags.mockResolvedValue({ modelConfigured: true, reasons: many });
    render(<ReasonTagsCard />);
    await screen.findByText("words number 0");
    expect(screen.queryByText("words number 5")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 7" }));
    expect(screen.getByText("words number 6")).toBeTruthy();
  });
});
