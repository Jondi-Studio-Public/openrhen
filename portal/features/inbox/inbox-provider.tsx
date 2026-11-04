"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useMediaQuery } from "@/shared/use-media-query";
import { useNow } from "@/shared/clock";
import { extensionQueueRows } from "@/state/extensions";
import { usePortal } from "@/state/portal-provider";
import { useProposalReview, type ProposalReview } from "@/features/capture/use-proposal-review";
import { isEmailThreadChange } from "@/features/capture/email-threads";
import {
  refreshEmailReviewCount,
  useEmailReviewCount,
  type EmailReviewCount
} from "@/features/capture/email-review-count";
import { refreshCalendarReviewCount, useCalendarReviewCount } from "@/features/calendar-sync/calendar-review-count";
import type { CalendarReviewCount } from "@/features/calendar-sync/calendar-review-count";
import type { useImportWorkflow } from "@/features/imports/use-import-workflow";
import { useImportWorkflowContext } from "@/features/imports/import-workflow-provider";
import type { CaptureItem } from "@/state/portal-state";
import { shownAgentProposals, useAgentProposals } from "@/features/agent-proposals/agent-proposals-store";
import { usePlanMapReview, type PlanMapReview } from "@/features/plan-map/use-plan-map-review";
import { canUndoIgnore } from "@/features/capture/capture-commands";
import { useRoomCounts } from "./use-room-counts";
import { useInboxDecisions, type InboxDecisions } from "./use-inbox-decisions";
import type { RoomCounts } from "./rooms";
import { buildQueue, type QueueEntry } from "./queue";

type ImportWorkflow = ReturnType<typeof useImportWorkflow>;

export interface InboxContext {
  desk: boolean;
  imports: ImportWorkflow;
  proposals: ProposalReview;
  /** Pending email thread changes, shown in the Emails room. */
  emailItems: CaptureItem[];
  /** Every other pending proposal, shown in the Captured room. */
  otherPending: CaptureItem[];
  emailCount: EmailReviewCount;
  calendarReview: CalendarReviewCount;
  counts: RoomCounts;
  /** Every row the Inbox can list, in queue order; each chip shows a slice of it. */
  queue: QueueEntry[];
  /** The plan map's suggested links and findings, with their decisions. */
  planMap: PlanMapReview;
  /** Opens a held batch in the review pane; on a desk it first closes any open proposal. */
  openBatch: (id: string) => void;
  /**
   * Cards on their way out, the ids hidden while their write runs, the toast after a decision, and
   * `decide` for a room that owns its own state (the Plan map) to raise one.
   */
  decisions: Pick<InboxDecisions, "leaving" | "hidden" | "toast" | "dismiss" | "decide">;
  /** Ignores proposals with the exit motion and an Undo toast where the ignore can be undone. */
  ignore: (ids: readonly string[]) => Promise<void>;
  /** Confirms one email change with the exit motion; rejects with the refusal, which the card shows. */
  confirmEmailChange: (item: CaptureItem, answers: Record<string, string>) => Promise<void>;
  /** Confirms the proposal open in the editor, leaving the list the same way once it validates. */
  confirmReviewed: (tentative?: boolean) => Promise<void>;
  /** Drops a Someday or Reference item with a "Dropped · Undo" toast; Undo files it again as it was. */
  dropKept: (id: string) => Promise<void>;
}

const Inbox = createContext<InboxContext | null>(null);

export function useInbox(): InboxContext {
  const value = useContext(Inbox);
  if (!value) throw new Error("useInbox must be used inside the Inbox layout.");
  return value;
}

/**
 * The Inbox's shared state. Each chip is its own address, but a proposal under review, a batch being
 * previewed and the counts the chips show must survive moving between them, so the workflow hooks and
 * the queue live here, above every filter, rather than in any one page.
 */
export function InboxProvider({ children }: { children: ReactNode }) {
  const desk = useMediaQuery("(min-width: 1024px)");
  const { extensions, state: portalState } = usePortal();
  const agentProposals = useAgentProposals();
  const now = useNow("minute");
  // Owned by the shell, so the `+` sheet's imports land in this queue.
  const imports = useImportWorkflowContext();
  // The shell keeps the workflow across pages, which fetches the queue once. Entering the Inbox asks
  // again, so a batch made by the CLI or another browser appears, and a failed first fetch recovers.
  const { refreshQueue, refreshOpenBatch } = imports;
  useEffect(() => {
    void refreshQueue();
    // Likewise the batch left open under review: the render that mounts the Inbox holds the current one.
    void refreshOpenBatch();
    // Only on entering the Inbox; the batch changing under review must not trigger a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshQueue]);
  const proposals = useProposalReview();
  const emailCount = useEmailReviewCount();
  const calendarReview = useCalendarReviewCount();
  const counts = useRoomCounts();

  // The held batches change when the Inbox does: on arrival, and whenever a batch is committed,
  // discarded or superseded, which moves the queue.
  const queueSignature = imports.queue.map((entry) => `${entry.id}:${entry.version}`).join(",");
  useEffect(() => {
    void refreshCalendarReviewCount();
  }, [queueSignature, imports.history.length]);

  const decisions = useInboxDecisions();
  // A decided card is hidden as soon as its exit ends, not when the server answers.
  const visible = proposals.pending.filter((item) => !decisions.hidden.has(item.id));
  const emailItems = visible.filter(isEmailThreadChange);
  const otherPending = visible.filter((item) => !isEmailThreadChange(item));
  // The Emails badge moves when a change is confirmed, ignored or superseded, or a run is ingested.
  const emailSignature = emailItems.map((item) => `${item.id}:${item.version}`).join(",");
  useEffect(() => {
    void refreshEmailReviewCount();
  }, [emailSignature]);

  const planMap = usePlanMapReview(decisions);
  // Cheap enough to build each render; the page keys its selection on entry keys, not this array.
  const queue = buildQueue({
    emailItems,
    otherPending,
    agentProposals: shownAgentProposals(agentProposals),
    extensionRows: extensionQueueRows(extensions),
    calendarReview,
    importQueue: imports.queue,
    links: planMap.map?.links ?? [],
    findings: planMap.map?.findings ?? [],
    someday: proposals.someday.filter((item) => !decisions.hidden.has(item.id)),
    reference: proposals.reference.filter((item) => !decisions.hidden.has(item.id)),
    emailContext: proposals.emailChangeContext,
    titleOf: planMap.resolver.titleOf,
    now,
    timezone: portalState.settings.timezone
  });

  const openBatch = (id: string) => {
    if (desk) proposals.cancel();
    void imports.openBatch(id);
  };

  const ignore = async (ids: readonly string[]) => {
    const undoable = ids.every((id) => canUndoIgnore(proposals.state.captures.find((item) => item.id === id)));
    const ignored: string[] = [];
    await decisions.decide(
      ids,
      "ignore",
      async () => {
        for (const id of ids) if (await proposals.ignore(id)) ignored.push(id);
        return ignored;
      },
      undoable ? { kind: "undo", run: () => proposals.unignore(ignored) } : { kind: "view" }
    );
  };
  const dropKept = async (id: string) => {
    const kept = proposals.state.captures.find((item) => item.id === id);
    await decisions.decide(
      [id],
      "ignore",
      () => proposals.drop(id),
      kept && canUndoIgnore(kept) ? { kind: "undo", run: () => proposals.keepAgain(kept) } : { kind: "view" },
      "Dropped"
    );
  };
  const confirmEmailChange = async (item: CaptureItem, answers: Record<string, string>) => {
    await decisions.decide([item.id], "confirm", () => proposals.confirmEmailChange(item, answers));
  };
  const confirmReviewed = async (tentative = false) => {
    // The toast names what was added, from the draft as it stands now. A confirm has already made its record, so it
    // still offers the way to Recently handled rather than an Undo.
    const { draft } = proposals;
    const title = draft.title.trim();
    const project = proposals.state.projects.find((item) => item.id === draft.projectId);
    const kept = draft.proposalType === "someday" || draft.proposalType === "reference";
    const subject =
      title === ""
        ? undefined
        : kept
          ? `Kept for later: ${title}`
          : project
            ? `Added to ${project.title}: ${title}`
            : `Added: ${title}`;
    await proposals.confirm(tentative, (id, save) =>
      decisions.decide([id], "confirm", save, { kind: "view" }, undefined, undefined, subject)
    );
  };

  return (
    <Inbox.Provider
      value={{
        desk,
        imports,
        proposals,
        emailItems,
        otherPending,
        emailCount,
        calendarReview,
        counts,
        queue,
        planMap,
        openBatch,
        decisions: {
          leaving: decisions.leaving,
          hidden: decisions.hidden,
          toast: decisions.toast,
          dismiss: decisions.dismiss,
          decide: decisions.decide
        },
        ignore,
        confirmEmailChange,
        confirmReviewed,
        dropKept
      }}
    >
      {children}
    </Inbox.Provider>
  );
}
