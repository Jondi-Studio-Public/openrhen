"use client";

import { Fragment, useState } from "react";
import type { AgentProposal } from "@openrhen/contracts";
import { useNow } from "@/shared/clock";
import { ageLabel, dismissHeldAgentProposal, type ResolveOutcome } from "../agent-proposals-store";
import { sentenceCase } from "@/features/inbox/source-label";
import { Button } from "@/components/ui/button";
import { clean, proposalChanges, type ChangeGroup, type FindRecord } from "../proposal-changes";
import styles from "./proposal-changes.module.css";

const VALUE_MAX = 500;

/** A long value is cut for reading, with the whole of it one click away. */
function Value({ text }: { text: string }) {
  if (text.length <= VALUE_MAX) return <>{text}</>;
  return (
    <>
      {text.slice(0, VALUE_MAX)}…
      <details className={styles.more}>
        <summary>show all</summary>
        {text}
      </details>
    </>
  );
}

function Group({ group }: { group: ChangeGroup }) {
  return (
    <div className={styles.group}>
      <p className={styles.groupTitle}>{group.title}</p>
      {group.caution && <p className={styles.caution}>{group.caution}</p>}
      {group.rows.length > 0 && (
        <dl className={styles.rows}>
          {group.rows.map((row, i) => (
            <Fragment key={`${row.field}-${i}`}>
              <dt>{row.field}</dt>
              <dd>
                <Value text={row.value} />
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

/** What confirming will apply, from the stored payload, plus the exact request for anyone who wants to check it. */
function ProposalChanges({ groups, proposal }: { groups: ChangeGroup[] | null; proposal: AgentProposal }) {
  return (
    <section className={styles.changes} aria-label="What confirming applies">
      <p className={styles.heading}>What confirming applies</p>
      {groups === null ? (
        <p className={styles.unknown}>
          This portal cannot describe this change; read the exact request before confirming.
        </p>
      ) : (
        groups.map((group, i) => <Group key={i} group={group} />)
      )}
      <details className={styles.exact}>
        <summary>Exact request</summary>
        <pre className={styles.json}>{JSON.stringify(proposal.payload, null, 2)}</pre>
      </details>
    </section>
  );
}
import flat from "@/components/ui/embedded.module.css";

/** The words the person sees for what a stale diff row says. */
function conflictLine(entity: string, proposedAgainst: number | null, current: number | null): string {
  const name = entity.replace(":", " ");
  if (current === null) return `${name} no longer exists.`;
  return `${name} is now version ${current}; the agent saw ${proposedAgainst ?? "none"}.`;
}

const STALE_MESSAGE = "This changed since the agent asked. Ask it again.";

/**
 * One write an agent proposed instead of making. Confirm applies the stored change as that agent; if
 * the record changed after the agent looked, nothing is applied and the card says what moved. The portal
 * has then settled the proposal as stale, and the store keeps it listed (`shownAgentProposals`) so the
 * card stays with that message until it is dismissed (its record stays in Recently handled). The
 * Inbox shows it in its detail pane (`embedded`, without its own card edge); Review lists it.
 */
export function AgentProposalCard({
  proposal,
  onResolve,
  embedded = false,
  findRecord,
  timezone
}: {
  proposal: AgentProposal;
  onResolve: (id: string, decision: "confirm" | "reject", revision: number) => Promise<ResolveOutcome>;
  embedded?: boolean;
  findRecord?: FindRecord | undefined;
  /** The plan's zone, which dates in the change are read in. */
  timezone?: string | undefined;
}) {
  const now = useNow("minute");
  const groups = proposalChanges(proposal, findRecord, { ...(timezone ? { timezone } : {}), now });
  // A change that moves more than its own record (settings, the time zone) is confirmed without the Inbox's
  // primary weight, so the largest target is never the risky one.
  const risky = groups?.some((group) => group.caution !== undefined) ?? false;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; lines: string[] } | null>(null);

  const decide = async (decision: "confirm" | "reject") => {
    setBusy(true);
    const outcome = await onResolve(proposal.id, decision, proposal.revision);
    setBusy(false);
    setProblem(
      outcome.ok
        ? null
        : {
            message: outcome.stale ? STALE_MESSAGE : outcome.message,
            lines: outcome.conflicts.map((c) => conflictLine(c.entity, c.proposedAgainst, c.current))
          }
    );
  };

  // Settled as stale once the list refreshed: nothing is left to confirm or reject, only to clear.
  const settled = proposal.status === "stale";
  const shown = problem ?? (settled ? { message: STALE_MESSAGE, lines: [] } : null);
  // Ties each button to the change it acts on, so a screen reader hears more than a row of "Confirm". An embedded
  // card's summary is the Inbox detail pane's own title.
  const summaryId = embedded ? undefined : `agent-proposal-${proposal.id}`;
  return (
    <article className={embedded ? flat.card : "review-card"}>
      {!embedded && <p id={summaryId}>{proposal.summary}</p>}
      {proposal.evidence && (
        <p className={embedded ? flat.note : "proposal-note"}>{`Agent's evidence: ${clean(proposal.evidence)}`}</p>
      )}
      <ProposalChanges groups={groups} proposal={proposal} />
      <small className={embedded ? flat.source : "source-line"}>
        <span>
          {sentenceCase(proposal.agent)} · {proposal.basis.replaceAll("_", " ")} ·{" "}
          {ageLabel(proposal.createdAt, now.getTime())}
          {proposal.revision > 1 ? ` · updated ${proposal.revision - 1}×` : ""}
        </span>
      </small>
      {shown && (
        <div className="form-error" role="alert">
          <p>{shown.message}</p>
          {shown.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      <div className={embedded ? flat.actions : "review-actions"}>
        {settled ? (
          <Button
            variant="ghost"
            size={embedded ? "md" : "sm"}
            aria-describedby={summaryId}
            onClick={() => dismissHeldAgentProposal(proposal.id)}
          >
            Dismiss
          </Button>
        ) : (
          <>
            <Button
              variant={embedded && !risky ? "primary" : "secondary"}
              size={embedded ? "md" : "sm"}
              data-inbox-action="yes"
              data-inbox-weight={risky ? "quiet" : undefined}
              aria-describedby={summaryId}
              disabled={busy}
              onClick={() => void decide("confirm")}
            >
              Confirm
            </Button>
            <Button
              variant="ghost"
              size={embedded ? "md" : "sm"}
              data-inbox-action="no"
              aria-describedby={summaryId}
              disabled={busy}
              onClick={() => void decide("reject")}
            >
              Reject
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

/** Review's "From agents" section: every write agents are waiting on, above Agent changes, and any just found stale. */
export function AgentProposalList({
  proposals,
  onResolve,
  findRecord,
  timezone
}: {
  proposals: readonly AgentProposal[];
  findRecord?: FindRecord | undefined;
  timezone?: string | undefined;
  onResolve: (id: string, decision: "confirm" | "reject", revision: number) => Promise<ResolveOutcome>;
}) {
  if (proposals.length === 0) return null;
  return (
    <section className="inbox-proposals" aria-labelledby="inbox-agent-proposals-heading">
      <div className="section-heading">
        <h2 id="inbox-agent-proposals-heading">From agents</h2>
        <span>{proposals.length}</span>
      </div>
      {proposals.map((proposal) => (
        <AgentProposalCard
          key={proposal.id}
          proposal={proposal}
          onResolve={onResolve}
          findRecord={findRecord}
          timezone={timezone}
        />
      ))}
    </section>
  );
}
