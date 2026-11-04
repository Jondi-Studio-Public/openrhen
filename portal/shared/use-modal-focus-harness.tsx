import { useRef, type ReactElement } from "react";
import { vi } from "vitest";
import { useModalFocus } from "./use-modal-focus";

/**
 * Components `use-modal-focus.test.ts` renders. They live in a `.tsx` file of their own because the
 * test has to stay a `.test.ts` (vitest.unit.config.ts's `shared/**` include only picks up
 * `.test.ts`, unlike `components/**` and `features/**`, which also include `.test.tsx`), and a ref
 * handed to an element through `createElement` props is a pattern the React lint rules read as
 * reading the ref during render, where JSX `ref={...}` is the form they understand.
 */
export function Harness({ active, onClose }: { active: boolean; onClose: () => void }): ReactElement {
  const trapRef = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useModalFocus({ active, trapRef, onClose });
  return (
    <div>
      <button>Opener</button>
      {active && (
        <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Test dialog" tabIndex={-1} onKeyDown={onKeyDown}>
          <input aria-label="First" />
          <button>Last</button>
        </div>
      )}
    </div>
  );
}

/** Mirrors a plan editor's collapsed `<summary>`: a focusable element earlier in the DOM than the
 * field that should actually take focus, hidden the way real hidden markup is hidden. */
export function HarnessWithScopedInitialFocus({ active }: { active: boolean }): ReactElement {
  const trapRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useModalFocus({ active, trapRef, initialFocusRef: scopeRef, onClose: vi.fn() });
  return (
    <div ref={trapRef} role="dialog" tabIndex={-1} onKeyDown={onKeyDown}>
      <button>Not in scope</button>
      <div ref={scopeRef}>
        <button style={{ display: "none" }}>Hidden</button>
        <input aria-label="First" />
      </div>
    </div>
  );
}

export function HiddenTail(): ReactElement {
  const trapRef = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useModalFocus({ active: true, trapRef, onClose: vi.fn() });
  return (
    <div ref={trapRef} role="dialog" tabIndex={-1} onKeyDown={onKeyDown}>
      <input aria-label="First" />
      <button>Visible last</button>
      <details>
        <summary>More</summary>
        <button>Collapsed</button>
      </details>
      <button style={{ display: "none" }}>Hidden</button>
    </div>
  );
}
