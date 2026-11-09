// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { AreaWorkLabel } from "./area-work-label";

const client = vi.hoisted(() => ({ fetchWorkLabels: vi.fn(), putWorkLabel: vi.fn() }));
vi.mock("@/features/plan/work-label-client", () => client);

const unknown = { areaId: "a1", value: "unknown", origin: null, at: null };

beforeEach(() => {
  client.fetchWorkLabels.mockReset();
  client.putWorkLabel.mockReset();
});

describe("AreaWorkLabel", () => {
  it("loads the area's label and shows it", async () => {
    client.fetchWorkLabels.mockResolvedValue({
      modelConfigured: true,
      labels: [
        { areaId: "other", value: "not_work", origin: "inferred", at: null },
        { areaId: "a1", value: "work", origin: "inferred", at: "2026-11-09T10:00:00.000Z" }
      ]
    });
    render(<AreaWorkLabel areaId="a1" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Counts as work: Yes (inferred)"));
  });

  it("goes back to loading when the area changes", async () => {
    client.fetchWorkLabels.mockResolvedValueOnce({
      modelConfigured: true,
      labels: [{ areaId: "a1", value: "work", origin: "inferred", at: null }]
    });
    const view = render(<AreaWorkLabel areaId="a1" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Yes"));
    client.fetchWorkLabels.mockReturnValueOnce(new Promise(() => {}));
    view.rerender(<AreaWorkLabel areaId="a2" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).not.toContain("Yes"));
  });

  it("treats an area with no entry as not decided", async () => {
    client.fetchWorkLabels.mockResolvedValue({ modelConfigured: true, labels: [] });
    render(<AreaWorkLabel areaId="a1" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Counts as work: Not decided yet"));
  });

  it("writes one tap through the server route with a fresh request id and shows what it answers", async () => {
    client.fetchWorkLabels.mockResolvedValue({ modelConfigured: true, labels: [unknown] });
    client.putWorkLabel.mockResolvedValue({
      areaId: "a1",
      value: "not_work",
      origin: "corrected",
      at: "2026-11-09T10:00:00.000Z"
    });
    render(<AreaWorkLabel areaId="a1" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Not decided yet"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Counts as work: no" }));
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Counts as work: No (your answer)"));
    expect(client.putWorkLabel).toHaveBeenCalledWith("a1", "not_work", expect.stringMatching(/^[0-9a-f-]{36}$/));
    await act(async () => {
      client.putWorkLabel.mockResolvedValue(unknown);
      fireEvent.click(screen.getByRole("button", { name: "Counts as work: reset" }));
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Not decided yet"));
    const ids = client.putWorkLabel.mock.calls.map((call) => call[2]);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps what was shown and says so when the save fails, and when the load fails", async () => {
    client.fetchWorkLabels.mockResolvedValue({ modelConfigured: true, labels: [unknown] });
    client.putWorkLabel.mockRejectedValue(
      new Error("That area is not here. It may have been removed; reload the page.")
    );
    render(<AreaWorkLabel areaId="a1" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Not decided yet"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Counts as work: yes" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("That area is not here"));
    expect(screen.getByRole("status").textContent).toContain("Not decided yet");

    document.body.innerHTML = "";
    client.fetchWorkLabels.mockRejectedValue(new Error("The portal answered 503. Reload the page and try again."));
    render(<AreaWorkLabel areaId="a1" />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("503"));
  });
});
