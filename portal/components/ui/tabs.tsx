import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "./badge";
import { Count } from "./count";
import { cx } from "./cx";
import styles from "./tabs.module.css";

export type TabItem = { href: string; label: string; count?: number; badge?: string; dot?: boolean; active: boolean };

/**
 * Navigation between sibling pages of one section, drawn as an underlined strip. These are links,
 * not a tablist: each goes to its own URL, and the current one carries aria-current="page".
 */
export function Tabs({
  items,
  label,
  className
}: {
  items: ReadonlyArray<TabItem>;
  label?: string | undefined;
  className?: string | undefined;
}): ReactNode {
  return (
    <nav aria-label={label} className={cx(styles.tabs, className)}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className={cx(styles.tab, item.active && styles.on)}
        >
          {item.label}
          {item.count === undefined ? null : <Count value={item.count} />}
          {item.badge === undefined ? null : (
            <Badge tone="warn" dot={item.dot ?? false}>
              {item.badge}
            </Badge>
          )}
        </Link>
      ))}
    </nav>
  );
}
