"use client";

import { cx } from "@/components/ui/cx";
import Link from "next/link";
import { Children, type ReactNode } from "react";
import type { StoredProject } from "@/state/portal-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import styles from "./weekly-review.module.css";

export type StepState = "done" | "current" | "later";

function Tick() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

/**
 * One step of the weekly review as a card: a numbered disc (a tick once the step has nothing left),
 * the step's name and one line of where it stands, and, while it has work, that work underneath.
 * The current step, the first with anything left, is raised so the eye lands on it.
 */
export function ReviewStep({
  number,
  state,
  title,
  summary,
  count,
  children
}: {
  number: number;
  state: StepState;
  title: string;
  summary: ReactNode;
  count?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card
      as="section"
      className={state === "current" ? `${styles.step} ${styles.current}` : styles.step}
      aria-label={`Step ${number}: ${title}`}
    >
      <div className={styles.head}>
        <span className={`${styles.disc} ${styles[state]}`} aria-hidden="true">
          {state === "done" ? <Tick /> : number}
        </span>
        <div className={styles.text}>
          <h3 className={styles.title}>
            {title}
            {state === "done" && <span className="visually-hidden"> (done)</span>}
          </h3>
          <p className={styles.summary}>{summary}</p>
        </div>
        {count !== undefined && <span className={styles.count}>{count}</span>}
      </div>
      {Children.toArray(children).length > 0 && <div className={styles.body}>{children}</div>}
    </Card>
  );
}

/** The step states for a list of "has work left" flags: done, then the first with work is current. */
export function stepStates(hasWork: boolean[]): StepState[] {
  const current = hasWork.findIndex(Boolean);
  return hasWork.map((work, index) => (!work ? "done" : index === current ? "current" : "later"));
}

export type StaleChoice = "keep" | "pause" | "drop";

/**
 * Step 2's work: each stale project with Keep, Pause and Drop, its title a link to its card in Plan.
 * A desk lists them; a phone shows one card at a time with its open actions, as the mockup's
 * one-decision-at-a-time flow (the step's header counts "3 of 8").
 */
export function StaleProjects({
  projects,
  hrefOf,
  describe,
  openActions,
  onChoose,
  busy,
  oneAtATime
}: {
  projects: StoredProject[];
  hrefOf: (project: StoredProject) => string;
  describe: (project: StoredProject) => string;
  openActions: (project: StoredProject) => string[];
  onChoose: (project: StoredProject, choice: StaleChoice) => void;
  busy: string | null;
  oneAtATime: boolean;
}) {
  const choices = (project: StoredProject, primary: boolean) => (
    <span className={primary ? styles.choicesWide : styles.choices}>
      <Button
        size={primary ? "md" : "sm"}
        variant={primary ? "primary" : "secondary"}
        disabled={busy !== null}
        onClick={() => onChoose(project, "keep")}
      >
        Keep
      </Button>
      <Button
        size={primary ? "md" : "sm"}
        variant={primary ? "secondary" : "ghost"}
        disabled={busy !== null}
        onClick={() => onChoose(project, "pause")}
      >
        Pause
      </Button>
      <Button
        size={primary ? "md" : "sm"}
        variant={primary ? "secondary" : "ghost"}
        disabled={busy !== null}
        onClick={() => onChoose(project, "drop")}
      >
        Drop
      </Button>
    </span>
  );
  if (oneAtATime) {
    const project = projects[0];
    if (!project) return null;
    const actions = openActions(project);
    return (
      <div className={styles.single}>
        <p className={styles.singleTitle}>
          <Link href={hrefOf(project)} className={styles.titleLink}>
            {project.title}
          </Link>
        </p>
        <p className={styles.summary}>{describe(project)}</p>
        {actions.length > 0 && (
          <ul className={styles.actions}>
            {actions.slice(0, 2).map((title) => (
              <li key={title}>{title}</li>
            ))}
            {actions.length > 2 && <li>and {actions.length - 2} more</li>}
          </ul>
        )}
        {choices(project, true)}
      </div>
    );
  }
  return (
    <List>
      {projects.map((project) => (
        <ListRow
          key={project.id}
          className={cx(styles.staleRow)}
          title={
            <Link href={hrefOf(project)} className={styles.titleLink}>
              {project.title}
            </Link>
          }
          meta={describe(project)}
          trailing={choices(project, false)}
        />
      ))}
    </List>
  );
}
