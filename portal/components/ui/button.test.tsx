// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { Button, ButtonLink } from "./button";

describe("Button", () => {
  it("is a named button that does not submit a form by default", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("type")).toBe("button");
  });

  it("calls onClick and stays silent when disabled", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} disabled>
        Go
      </Button>
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Go" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("forwards its ref and native props", () => {
    let node: HTMLButtonElement | null = null;
    render(
      <Button
        ref={(el) => {
          node = el;
        }}
        type="submit"
        aria-describedby="x"
      >
        Send
      </Button>
    );
    expect(node).toBe(screen.getByRole("button", { name: "Send" }));
    expect(node!.getAttribute("type")).toBe("submit");
  });

  it("changes class with variant, size and block", () => {
    render(
      <>
        <Button>A</Button>
        <Button variant="primary" size="lg" block>
          B
        </Button>
      </>
    );
    expect(screen.getByRole("button", { name: "A" }).className).not.toBe(
      screen.getByRole("button", { name: "B" }).className
    );
  });

  it("adds a class that lets a long label wrap only when asked", () => {
    render(
      <>
        <Button variant="primary">Short</Button>
        <Button variant="primary" wrap>
          Long
        </Button>
      </>
    );
    const plain = screen.getByRole("button", { name: "Short" }).className.split(" ");
    const wrapped = screen.getByRole("button", { name: "Long" }).className.split(" ");
    expect(wrapped.length).toBe(plain.length + 1);
    expect(wrapped).toEqual(expect.arrayContaining(plain));
  });
});

describe("ButtonLink", () => {
  it("renders a link to the href with the button look", () => {
    render(
      <>
        <Button variant="primary">Btn</Button>
        <ButtonLink href="/plan" variant="primary">
          Open plan
        </ButtonLink>
      </>
    );
    const link = screen.getByRole("link", { name: "Open plan" });
    expect(link.getAttribute("href")).toBe("/plan");
    expect(link.className).toBe(screen.getByRole("button", { name: "Btn" }).className);
  });
});
