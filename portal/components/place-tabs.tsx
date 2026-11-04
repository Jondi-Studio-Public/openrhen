"use client";

import { usePathname } from "next/navigation";
import { Tabs } from "./ui/tabs";
import { activePlaceTab, placeTabs } from "./app-nav-tabs";
import { usePortal } from "@/state/portal-provider";
import { useNow } from "@/shared/clock";
import { CLOSED_DELIVERABLE_STATUSES } from "@/features/deliverables/deliverable-model";
import { reviewProgress } from "@/features/review/review-progress";
import type { PortalState } from "@/state/portal-state";
import type { ClientForecast } from "@/state/portal-provider";
import styles from "./place-tabs.module.css";

/** What a tab wears beside its label: a count, or a word such as "Due". */
export type TabMarks = Readonly<Record<string, number | string | undefined>>;

/**
 * Open deliverables on the Deliverables tab, and "Due" (with a dot) on Review while steps of this week's review
 * remain and the week has not been marked reviewed.
 */
export function placeTabMarks(state: PortalState, now: Date, forecasts: readonly ClientForecast[] = []): TabMarks {
  const open = (state.deliverables ?? []).filter((item) => !CLOSED_DELIVERABLE_STATUSES.has(item.status)).length;
  return {
    "/deliverables": open > 0 ? open : undefined,
    "/review": reviewProgress(state, forecasts, now).due ? "Due" : undefined
  };
}

/** The tabs a path's place draws, with their marks; undefined outside a tabbed place. */
export function placeTabItems(pathname: string | null, marks: TabMarks = {}) {
  const current = activePlaceTab(pathname);
  const tabs = current ? placeTabs[current.tab] : undefined;
  if (!current || !tabs) return undefined;
  return {
    label: current.tab === "day" ? "Day" : "Plan",
    items: tabs.map((item) => {
      const mark = marks[item.href];
      return {
        href: item.href,
        label: item.label,
        active: item.href === current.href,
        ...(typeof mark === "number"
          ? { count: mark }
          : typeof mark === "string"
            ? { badge: mark, dot: item.href === "/review" }
            : {})
      };
    })
  };
}

/**
 * The tabs inside a place that has more than one page: Day | Week, and Plan's Areas | Deliverables |
 * Map | Review. A page draws it straight under its header, as the boards do. Renders nothing outside a
 * tabbed place.
 */
export function PlaceTabs() {
  const pathname = usePathname();
  const { state, forecasts } = usePortal();
  const now = useNow("minute");
  const tabs = placeTabItems(pathname, placeTabMarks(state, now, forecasts));
  if (!tabs) return null;
  return <Tabs className={styles.strip} label={tabs.label} items={tabs.items} />;
}
