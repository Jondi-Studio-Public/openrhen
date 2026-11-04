// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ConditionDefinition } from "@/features/settings/context-summary";
import { fireEvent, render, screen } from "@/test/render";
import { ContactPicker } from "./contact-picker";

const definitions = [
  { id: "sam", name: "Sam", kind: "contact", status: "active", channels: [] },
  { id: "priya", name: "Priya", kind: "contact", status: "active", channels: [] },
  { id: "old-contact", name: "Old contact", kind: "contact", status: "archived", channels: [] },
  { id: "campus", name: "Campus", kind: "location", status: "active" }
] as unknown as ConditionDefinition[];

const picker = (overrides: Partial<Parameters<typeof ContactPicker>[0]> = {}) => (
  <ContactPicker
    definitions={definitions}
    contactId=""
    onSelect={() => {}}
    onCreate={() => Promise.reject(new Error("not expected"))}
    {...overrides}
  />
);

describe("ContactPicker", () => {
  it("lists only the active contacts, never a location or an archived one", () => {
    render(picker());
    const select = screen.getByLabelText("Contact") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["— none —", "Sam", "Priya"]);
  });

  it("reports None as an empty id", () => {
    const onSelect = vi.fn();
    render(picker({ contactId: "sam", onSelect }));
    fireEvent.change(screen.getByLabelText("Contact"), { target: { value: "" } });
    expect(onSelect).toHaveBeenCalledWith("");
  });

  it("shows an unresolved contactId as unavailable rather than dropping it", () => {
    render(picker({ contactId: "old-contact" }));
    const select = screen.getByLabelText("Contact") as HTMLSelectElement;
    expect(select.value).toBe("old-contact");
    expect(screen.getByText("Contact no longer available")).toBeTruthy();
  });

  it("saves a new contact and selects it", async () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn().mockResolvedValue({ id: "jamie", name: "Jamie" });
    render(picker({ onSelect, onCreate }));
    fireEvent.click(screen.getByText("New contact…"));
    fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Jamie" } });
    fireEvent.click(screen.getByText("Save"));
    await Promise.resolve();
    await Promise.resolve();
    expect(onCreate).toHaveBeenCalledWith("Jamie");
    expect(onSelect).toHaveBeenCalledWith("jamie");
  });

  it("picks an existing name without inventing a new contact, exactly what onCreate itself decides", async () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn().mockResolvedValue({ id: "sam", name: "Sam" });
    render(picker({ onSelect, onCreate }));
    fireEvent.click(screen.getByText("New contact…"));
    fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Sam" } });
    fireEvent.click(screen.getByText("Save"));
    await Promise.resolve();
    await Promise.resolve();
    expect(onSelect).toHaveBeenCalledWith("sam");
  });

  it("shows the failure and leaves the form open when saving fails", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("Name already used by another kind."));
    render(picker({ onCreate }));
    fireEvent.click(screen.getByText("New contact…"));
    fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Sam" } });
    fireEvent.click(screen.getByText("Save"));
    await Promise.resolve();
    await Promise.resolve();
    expect(await screen.findByText("Name already used by another kind.")).toBeTruthy();
    expect(screen.getByLabelText("Contact name")).toBeTruthy();
  });
});
