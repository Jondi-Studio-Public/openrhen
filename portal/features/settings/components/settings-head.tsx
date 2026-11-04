import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { settingsSectionFor } from "../settings-sections";
import styles from "./settings-head.module.css";

/**
 * The top of every settings page: a way back to You, the page's title and one answer sentence, and
 * when its row owns more than one page, tabs to the others. `href` is the page's own address, which
 * picks its row and lights its tab.
 */
export function SettingsHead({
  href,
  title,
  answer,
  actions
}: {
  href: string;
  title?: string;
  answer?: ReactNode;
  actions?: ReactNode;
}) {
  const section = settingsSectionFor(href);
  const pages = section?.pages ?? [];
  return (
    <div className={styles.head}>
      <Link className={styles.back} href="/you">
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M10 3 5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        You
      </Link>
      <PageHeader
        title={title ?? section?.title ?? "Settings"}
        answer={answer}
        actions={actions}
        className={styles.header ?? ""}
      />
      {pages.length > 1 ? (
        <Tabs
          className={styles.tabs ?? ""}
          label={section!.title}
          items={pages.map((page) => ({ href: page.href, label: page.label, active: page.href === href }))}
        />
      ) : null}
    </div>
  );
}
