// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { List, ListRow } from "./list-row";

describe("ListRow", () => {
  it("is a plain row with no interactive role by default", () => {
    render(<ListRow title="Lunch" meta="Home" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Home")).toBeTruthy();
  });

  it("is a link to href, named by its content", () => {
    render(<ListRow title="Dentist" meta="Town" href="/events/1" />);
    const link = screen.getByRole("link", { name: /Dentist/ });
    expect(link.getAttribute("href")).toBe("/events/1");
    expect(link.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("is a button when given onClick", () => {
    const onClick = vi.fn();
    render(<ListRow title="Reschedule" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("can be disabled or marked as the chosen one of a set", () => {
    const onClick = vi.fn();
    render(
      <>
        <ListRow title="Stale" onClick={onClick} disabled />
        <ListRow title="Chosen" onClick={onClick} pressed />
      </>
    );
    const stale = screen.getByRole("button", { name: "Stale" }) as HTMLButtonElement;
    expect(stale.disabled).toBe(true);
    fireEvent.click(stale);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Chosen" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows time, leading and trailing slots", () => {
    render(<ListRow time="09:30" leading={<i data-testid="lead" />} title="Standup" trailing={<b>Soon</b>} />);
    expect(screen.getByText("09:30")).toBeTruthy();
    expect(screen.getByTestId("lead")).toBeTruthy();
    expect(screen.getByText("Soon")).toBeTruthy();
  });
});

describe("ListRow current", () => {
  it("marks the open row with aria-current on a button and a link", () => {
    render(
      <>
        <ListRow title="Button row" onClick={() => {}} current />
        <ListRow title="Link row" href="/x" current />
      </>
    );
    expect(screen.getByRole("button", { name: "Button row" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("link", { name: /Link row/ }).getAttribute("aria-current")).toBe("true");
  });

  it("leaves aria-current off by default and adds a class only to the current row", () => {
    render(
      <>
        <ListRow title="Other" onClick={() => {}} />
        <ListRow title="Open" onClick={() => {}} current />
      </>
    );
    const other = screen.getByRole("button", { name: "Other" });
    const open = screen.getByRole("button", { name: "Open" });
    expect(other.hasAttribute("aria-current")).toBe(false);
    expect(open.className).not.toBe(other.className);
  });
});

describe("List", () => {
  it("wraps its rows", () => {
    const { container } = render(
      <List>
        <ListRow title="A" />
        <ListRow title="B" />
      </List>
    );
    expect(container.firstElementChild!.children).toHaveLength(2);
  });
});
