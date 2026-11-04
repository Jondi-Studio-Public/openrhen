"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { applyChip, chipOfDraft, type CaptureChip } from "@/features/capture/capture-chips";
import { ProposalEditor } from "@/features/capture/components/proposal-editor";
import { AgentProposalCard } from "@/features/agent-proposals/components/agent-proposal-list";
import { usePortal } from "@/state/portal-provider";
import { recordInState } from "@/shared/record-in-state";
import { resolveAgentProposalRequest } from "@/features/agent-proposals/agent-proposals-store";
import { mailSource, renderExtensionQueueRow } from "@/state/extensions";
import { FindingCard, SuggestedLinkCard } from "@/features/plan-map/components/plan-map-review-cards";
import type { CaptureItem } from "@/state/portal-state";
import { useInbox } from "../inbox-provider";
import type { QueueEntry } from "../queue";
import { batchEffect, batchLines, captureEffect, projectChoices } from "../plan-effect";
import { ImportStatusBanners } from "@/features/imports/components/import-status-banners";
import { BatchReview } from "./batch-review";
import { PlanEffect } from "./plan-effect";
import styles from "./inbox-queue.module.css";

const text = (fields: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = fields?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
};

const chipLabels: { chip: CaptureChip; label: string }[] = [
  { chip: "task", label: "Task" },
  { chip: "time", label: "At a time" },
  { chip: "later", label: "Later" }
];

/**
 * A capture under review: its quote and questions inside the card, then one-tap chips (Task, At a
 * time, Later, Ignore) already on the likely answer, then Add to plan and Change first.
 */
function CaptureDetail({ item }: { item: CaptureItem }) {
  const { proposals, ignore, confirmReviewed } = useInbox();
  const [changing, setChanging] = useState(false);
  const note = text(item.proposedFields, "note");
  // The heading is the proposal's title; what was actually captured is quoted when it says more.
  const quote =
    note ?? (text(item.proposedFields, "title") && item.text !== item.proposedFields.title ? item.text : null);
  if (proposals.reviewingId !== item.id) return <p className="microcopy">Opening…</p>;
  const { draft, state } = proposals;
  const effect = captureEffect(draft, state);
  // Work that needs a project offers the likely ones as one tap; Other… opens the whole form.
  const choosing = !changing && (draft.proposalType === "action" || draft.proposalType === "deliverable");
  const choices = choosing
    ? projectChoices(draft, proposals.placementSuggestion?.projectId ?? null, state.projects)
    : [];
  const needsProject = draft.proposalType === "action" || draft.proposalType === "deliverable";
  // A commitment needs its times, and work needs a project that exists, so those forms open themselves.
  const fieldsHidden =
    !changing &&
    draft.proposalType !== "unclassified" &&
    draft.proposalType !== "fixed_commitment" &&
    !(needsProject && state.projects.length === 0);
  return (
    <>
      {quote && <blockquote className={styles.quote}>{`"${quote}"`}</blockquote>}
      {effect && <PlanEffect>{effect}</PlanEffect>}
      {!changing && (
        <div className={styles.choice} role="group" aria-labelledby={`type-choice-${item.id}`}>
          <p className={styles.choiceLabel} id={`type-choice-${item.id}`}>
            What is it?
          </p>
          <div className={styles.choiceRow}>
            {chipLabels.map(({ chip, label }) => (
              <Chip
                key={chip}
                pressed={chipOfDraft(draft.proposalType) === chip}
                onClick={() =>
                  proposals.setDraft(applyChip(draft, chip, state, proposals.placementSuggestion?.projectId ?? null))
                }
              >
                {label}
              </Chip>
            ))}
            <Button variant="ghost" data-inbox-action="no" onClick={() => void ignore([item.id])}>
              Ignore
            </Button>
          </div>
        </div>
      )}
      {choosing && (
        <div className={styles.choice} role="group" aria-labelledby={`project-choice-${item.id}`}>
          <p className={styles.choiceLabel} id={`project-choice-${item.id}`}>
            Which project does it belong to?
          </p>
          <div className={styles.choiceRow}>
            {choices.map((project) => (
              <Chip
                key={project.id}
                pressed={draft.projectId === project.id}
                onClick={() => proposals.setDraft({ ...draft, projectId: project.id })}
              >
                {project.title}
              </Chip>
            ))}
            <Chip pressed={false} onClick={() => setChanging(true)}>
              Other…
            </Chip>
          </div>
        </div>
      )}
      {item.sourceLink && (
        <p className="microcopy">
          <a href={item.sourceLink} target="_blank" rel="noreferrer">
            View source
          </a>
        </p>
      )}
      <ProposalEditor
        embedded
        state={proposals.state}
        draft={proposals.draft}
        error={proposals.error}
        onDraftChange={proposals.setDraft}
        onConfirm={() => void confirmReviewed()}
        onConfirmTentative={() => void confirmReviewed(true)}
        questions={proposals.questions}
        suggestion={proposals.placementSuggestion}
        answers={proposals.answers}
        onAnswer={(field, value) => proposals.setAnswers((current) => ({ ...current, [field]: value }))}
        typeChosenAbove={!changing}
        confirmLabel={draft.proposalType === "someday" ? "Keep for later" : "Add to plan"}
        // An unsorted capture has to be told what it is, so its fields open straight away.
        fieldsHidden={fieldsHidden}
        onShowFields={() => setChanging(true)}
        extraActions={
          // The chips carry Ignore until the full form opens; then it sits beside Add to plan again.
          changing ? (
            <Button variant="ghost" data-inbox-action="no" onClick={() => void ignore([item.id])}>
              Ignore
            </Button>
          ) : undefined
        }
      />
    </>
  );
}

/** Discards a held import after asking once; nothing committed is affected. */
function DiscardBatch({ batchId }: { batchId: string }) {
  const { imports } = useInbox();
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button variant="ghost" data-inbox-action="no" disabled={imports.busy} onClick={() => setAsking(true)}>
        Discard
      </Button>
    );
  return (
    <span className={styles.actions} role="group" aria-label="Discard this import?">
      <span className={styles.detailMeta}>Discard this import? Nothing committed is affected.</span>
      <Button variant="danger" disabled={imports.busy} onClick={() => void imports.deleteBatch(batchId)}>
        Discard
      </Button>
      <Button variant="ghost" onClick={() => setAsking(false)}>
        Keep it
      </Button>
    </span>
  );
}

/**
 * A calendar's held events or a held import: what committing it does first, with Add to plan when the
 * server has said it is ready, and the full review (every record's fields) behind Change first.
 */
function BatchDetail({ batchId }: { batchId: string }) {
  const { imports, openBatch } = useInbox();
  const [changing, setChanging] = useState(false);
  const batch = imports.batch?.id === batchId ? imports.batch : null;
  if (!batch)
    return (
      <>
        <div className={styles.actions}>
          <Button variant="primary" data-inbox-action="yes" disabled={imports.busy} onClick={() => openBatch(batchId)}>
            Open review
          </Button>
        </div>
        <div className={styles.actions}>
          <DiscardBatch batchId={batchId} />
        </div>
      </>
    );
  if (changing) return <BatchReview onClose={() => setChanging(false)} closeLabel="Done changing" />;
  const lines = batchLines(batch.records, batch.timezone);
  const selected = imports.calendarRecords.length === 0 || imports.selectedCalendarRecords.length > 0;
  const ready = batch.status === "ready" && imports.blocking === 0 && selected;
  return (
    <>
      {/* A commit from here that fails says so here, not only once the full review is opened. */}
      <ImportStatusBanners {...imports.reviewStatus} />
      <PlanEffect>
        <p>{batchEffect(batch.records)}</p>
        {lines.length > 0 && (
          <ul>
            {lines.slice(0, 5).map((line, at) => (
              <li key={at}>{line}</li>
            ))}
            {lines.length > 5 && <li>and {lines.length - 5} more</li>}
          </ul>
        )}
      </PlanEffect>
      {!ready && (
        <p className="microcopy">
          {imports.blocking > 0
            ? `${imports.blocking} need${imports.blocking === 1 ? "s" : ""} a fix before this can be added. Choose Change first.`
            : "This has not been checked yet. Choose Change first to check it."}
        </p>
      )}
      <div className={styles.actions}>
        <Button
          variant="primary"
          data-inbox-action="yes"
          disabled={imports.busy || !ready}
          onClick={() => void imports.commit()}
        >
          Add to plan
        </Button>
        <Button variant="secondary" onClick={() => setChanging(true)}>
          Change first
        </Button>
        <DiscardBatch batchId={batchId} />
      </div>
    </>
  );
}

/** Someday or reference: filed, not planned. Review again sends it back to Captured and follows it there. */
function KeptDetail({ item }: { item: CaptureItem }) {
  const { proposals, dropKept } = useInbox();
  const router = useRouter();
  return (
    <>
      {item.sourceLink && (
        <p className="microcopy">
          <a href={item.sourceLink} target="_blank" rel="noreferrer">
            View source
          </a>
        </p>
      )}
      {proposals.keptError && (
        <p className="form-error" role="alert">
          {proposals.keptError}
        </p>
      )}
      <div className={styles.actions}>
        <Button
          variant="primary"
          data-inbox-action="yes"
          onClick={async () => {
            if (!(await proposals.reopen(item.id))) return;
            // The address carries the item, so the Captured queue opens on it in the editor.
            router.push(`/inbox/captured?item=${encodeURIComponent(`capture:${item.id}`)}`, { scroll: false });
          }}
        >
          Review again
        </Button>
        <Button variant="ghost" data-inbox-action="no" onClick={() => void dropKept(item.id)}>
          Drop
        </Button>
      </div>
    </>
  );
}

/** The body that decides one entry, by kind. Each marks its main and its ignore button for Y and N. */
function DetailBody({ entry }: { entry: QueueEntry }) {
  const { proposals, decisions, ignore, confirmEmailChange, planMap } = useInbox();
  const { state } = usePortal();
  switch (entry.kind) {
    case "email": {
      const MailCard = mailSource()?.Card;
      if (!MailCard) return null;
      return (
        <MailCard
          headless
          items={entry.items}
          context={proposals.emailChangeContext}
          onConfirm={confirmEmailChange}
          onIgnore={ignore}
          leaving={decisions.leaving}
        />
      );
    }
    case "capture":
      return <CaptureDetail key={entry.item.id} item={entry.item} />;
    case "agent":
      return (
        <AgentProposalCard
          embedded
          proposal={entry.proposal}
          onResolve={resolveAgentProposalRequest}
          findRecord={(kind, id, sent) => recordInState(state, kind, id, sent)}
          timezone={state.settings.timezone}
        />
      );
    case "extension":
      return renderExtensionQueueRow(entry.extensionId, entry.row);
    case "calendar":
      return <BatchDetail batchId={entry.batchId} />;
    case "import":
      return <BatchDetail batchId={entry.batch.id} />;
    case "link":
      return (
        <SuggestedLinkCard
          link={entry.link}
          resolver={planMap.resolver}
          busy={planMap.busy}
          onDecide={(action) => void planMap.decideLink(entry.link.id, action)}
        />
      );
    case "finding":
      return (
        <FindingCard
          key={entry.finding.id}
          finding={entry.finding}
          resolver={planMap.resolver}
          busy={planMap.busy}
          onDecide={(action, answers) => void planMap.decideFinding(entry.finding.id, action, answers)}
        />
      );
    case "kept":
      return <KeptDetail item={entry.item} />;
  }
}

/**
 * The selected entry, decided in place: its tag and where it came from, the title, then the body
 * that decides it, with the questions it asks inside the card.
 */
export function QueueDetail({ entry }: { entry: QueueEntry }) {
  return (
    <>
      <div className={styles.detailHead}>
        <Badge tone={entry.tag.tone} dot={false}>
          {entry.tag.label}
        </Badge>
        {/* An email and an agent's proposal say where they came from in their own body. */}
        {entry.kind !== "email" && entry.kind !== "agent" && <span className={styles.detailMeta}>{entry.meta}</span>}
      </div>
      <h2 className={styles.detailTitle}>{entry.title}</h2>
      <div className={styles.detailBody}>
        <DetailBody entry={entry} />
      </div>
    </>
  );
}
