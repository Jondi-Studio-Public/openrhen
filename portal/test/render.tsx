import {
  render as renderElement,
  screen,
  within,
  fireEvent,
  cleanup,
  act,
  waitFor,
  type RenderResult
} from "@testing-library/react";
import { afterEach } from "vitest";
import type { ReactElement } from "react";

/**
 * Component tests use Testing Library under jsdom. A test file opts in with
 * `// @vitest-environment jsdom` on its first line and imports from here rather than from
 * `@testing-library/react` directly, so the automatic cleanup and any future portal-wide providers
 * live in one place. Prefer `screen.getByRole(...)` queries: they assert accessibility as a side effect.
 */
afterEach(() => cleanup());

export function render(element: ReactElement): RenderResult {
  return renderElement(element);
}

export { screen, within, fireEvent, act, waitFor };
