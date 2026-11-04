"use client";

import { isClosedStatus } from "@openrhen/contracts";
import type { StoredCommitment, StoredCommitmentRecurrenceRule, StoredProject } from "@/state/portal-state";
import { useNow } from "@/shared/clock";
import { describeCadence } from "@/features/commitments/commitment-routine";
import { wallClock } from "@/features/now/now-formatting";
import { formatZonedDate } from "@/shared/date-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { List, ListRow } from "@/components/ui/list-row";
import styles from "./rule-catalog.module.css";

/**
 * Every recurring commitment rule, grouped by whether it is still generating occurrences. Ported
 * from Today's `CommitmentRulePanel` — same summary line per rule — and this is where a rule is
 * edited now, through `onEdit` and the editor the page mounts behind it.
 *
 * Each row also points at the next occurrence the rule has actually materialized, when there is one.
 * That is the difference between the rule and the thing on the calendar: the rule says every seven
 * days at nine, the occurrence is a real commitment with an id, a place and a routine, and only the
 * occurrence has a page worth opening.
 */
export function RuleCatalog({
  rules,
  projects,
  commitments = [],
  timezone,
  now,
  onEdit
}: {
  rules: StoredCommitmentRecurrenceRule[];
  projects: StoredProject[];
  /** Materialized occurrences, searched for the next one each rule has produced. */
  commitments?: StoredCommitment[];
  timezone?: string;
  now?: Date;
  onEdit?: ((rule: StoredCommitmentRecurrenceRule) => void) | undefined;
}) {
  const active = rules.filter((rule) => rule.status === "active");
  const ended = rules.filter((rule) => rule.status === "ended");
  const clock = useNow("minute");
  const at = now ?? clock;
  /** The soonest occurrence of this rule that has not started yet; ended rules usually have none. */
  const nextOf = (rule: StoredCommitmentRecurrenceRule): StoredCommitment | undefined =>
    commitments
      .filter(
        (item) => item.recurrenceRuleId === rule.id && !isClosedStatus(item.status) && new Date(item.startsAt) >= at
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  const rows = (items: StoredCommitmentRecurrenceRule[]) => (
    <List>
      {items.map((item) => (
        <RuleRow
          key={item.id}
          item={item}
          projects={projects}
          next={nextOf(item)}
          timezone={timezone}
          onEdit={onEdit}
        />
      ))}
    </List>
  );
  return (
    <Card as="section" id="recurring" aria-label="Recurring commitments" className={styles.card}>
      <CardHeader
        title="Recurring commitments"
        trailing={<span className={styles.count}>{active.length} active</span>}
      />
      {active.length ? (
        rows(active)
      ) : (
        <EmptyState
          title="No recurring commitments"
          body="A commitment saved to repeat, such as a weekly shift or class, shows here."
        />
      )}
      {ended.length > 0 && (
        <>
          <h3 className={styles.group}>Ended · {ended.length}</h3>
          {rows(ended)}
        </>
      )}
    </Card>
  );
}

function RuleRow({
  item,
  projects,
  next,
  timezone,
  onEdit
}: {
  item: StoredCommitmentRecurrenceRule;
  projects: StoredProject[];
  next: StoredCommitment | undefined;
  timezone: string | undefined;
  onEdit?: ((rule: StoredCommitmentRecurrenceRule) => void) | undefined;
}) {
  const project = item.projectId
    ? (projects.find((candidate) => candidate.id === item.projectId)?.title ?? "project")
    : "";
  return (
    <ListRow
      title={item.title}
      meta={
        <>
          {describeCadence(item.repeat, item.startDate)} · {wallClock(item.localStartTime)}–
          {wallClock(item.localEndTime)}
          {item.location ? ` · ${item.location}` : ""}
          {project ? ` · ${project}` : ""}
          {next && timezone && (
            <>
              {" · "}
              <a className={styles.next} href={`/commitments/${encodeURIComponent(next.id)}`}>
                Next: {formatZonedDate(next.startsAt, timezone)}
              </a>
            </>
          )}
        </>
      }
      trailing={
        <>
          {item.shareToCalendar && <Badge dot={false}>Shared</Badge>}
          {item.private && <Badge dot={false}>Private</Badge>}
          {onEdit && (
            <Button variant="ghost" size="sm" onClick={() => onEdit(item)} aria-label={`Edit ${item.title}`}>
              Edit
            </Button>
          )}
        </>
      }
    />
  );
}
