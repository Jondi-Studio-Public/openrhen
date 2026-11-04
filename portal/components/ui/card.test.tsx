// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { Card, CardHeader } from "./card";

describe("Card", () => {
  it("renders as a div by default and as another element on request", () => {
    const { container } = render(
      <>
        <Card>plain</Card>
        <Card as="section" aria-label="Today">
          sectioned
        </Card>
      </>
    );
    expect(container.firstElementChild!.tagName).toBe("DIV");
    expect(screen.getByRole("region", { name: "Today" }).tagName).toBe("SECTION");
  });

  it("pads only when asked", () => {
    render(
      <>
        <Card>a</Card>
        <Card padded>b</Card>
      </>
    );
    expect(screen.getByText("a").className).not.toBe(screen.getByText("b").className);
  });
});

describe("CardHeader", () => {
  it("gives the card a heading and a trailing slot", () => {
    render(
      <Card>
        <CardHeader title="Next up" trailing={<a href="/plan">See all</a>} />
      </Card>
    );
    expect(screen.getByRole("heading", { level: 2, name: "Next up" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "See all" })).toBeTruthy();
  });

  it("can use a lower heading level", () => {
    render(<CardHeader title="Sub" as="h3" />);
    expect(screen.getByRole("heading", { level: 3, name: "Sub" })).toBeTruthy();
  });
});
