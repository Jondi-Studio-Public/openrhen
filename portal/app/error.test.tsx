// @vitest-environment jsdom
import { Component, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import ErrorPage from "./error";

/**
 * Next's app router wires `error.tsx` up as the fallback of an internal error boundary around each
 * route segment — this test recreates that wiring with a minimal boundary of its own, so a plain
 * render of a throwing child exercises `error.tsx` the same way Next does, without depending on Next's
 * internals.
 */
class TestBoundary extends Component<{ children: ReactNode }, { error: (Error & { digest?: string }) | null }> {
  state: { error: (Error & { digest?: string }) | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  reset = () => this.setState({ error: null });
  render() {
    return this.state.error ? <ErrorPage error={this.state.error} reset={this.reset} /> : this.props.children;
  }
}

function Thrower(): null {
  throw new Error("boom");
}

describe("error boundary fallback", () => {
  it("shows the boundary text and a retry button when a child throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <TestBoundary>
          <Thrower />
        </TestBoundary>
      );
    } finally {
      consoleError.mockRestore();
    }
    expect(screen.getByText("This page hit a snag.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Now" }).getAttribute("href")).toBe("/");
  });

  it("shows the reference when the server gave the error a digest, and none otherwise", () => {
    const { rerender } = render(
      <ErrorPage error={Object.assign(new Error("boom"), { digest: "abc123" })} reset={() => {}} />
    );
    expect(screen.getByText(/Reference abc123/)).toBeTruthy();
    rerender(<ErrorPage error={new Error("boom")} reset={() => {}} />);
    expect(screen.queryByText(/Reference/)).toBeNull();
  });
});
