import type { ReactNode } from "react";
import type { PrimaryTab } from "./app-nav-tabs";

/**
 * Line icons for the navigation and the few icon buttons, drawn inline so there is no icon dependency
 * to carry. Each one is decorative — the label beside it, or the button's own `aria-label`, is the
 * accessible name — so every icon is `aria-hidden`, which is what keeps a screen reader from
 * announcing "black circle, Now" the way the old Unicode glyphs did.
 */
function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="nav-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function TabIcon({ tab }: { tab: PrimaryTab }) {
  switch (tab) {
    case "now":
      return (
        <Icon>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
        </Icon>
      );
    case "day":
      return (
        <Icon>
          <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
        </Icon>
      );
    case "plan":
      return (
        <Icon>
          <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
          <path d="M9.5 3.5v17M9.5 12h11" />
        </Icon>
      );
    case "inbox":
      return (
        <Icon>
          <path d="M3.5 13.5h5l1.8 2.6h3.4l1.8-2.6h5" />
          <path d="M6 5h12l2.5 8.5v5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-5z" />
        </Icon>
      );
    case "you":
      return (
        <Icon>
          <circle cx="12" cy="8.5" r="3.8" />
          <path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" />
        </Icon>
      );
  }
}

export function PlusIcon({ size = 20 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function SearchIcon({ size = 18 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </Icon>
  );
}

export function ChevronIcon({ direction, size = 18 }: { direction: "left" | "right"; size?: number }) {
  return <Icon size={size}>{direction === "left" ? <path d="m15 6-6 6 6 6" /> : <path d="m9 6 6 6-6 6" />}</Icon>;
}
