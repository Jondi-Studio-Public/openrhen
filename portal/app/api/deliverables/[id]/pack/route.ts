import { CLOSED_STATUSES } from "@openrhen/contracts";
import { notFoundResponse } from "@/server/not-found-response";
import { redact, withRoute } from "@/server/logging";
import { assessDeliverable } from "@openrhen/contracts/readiness";
import { coverageFailureText, label, phaseOf, stepReadinessText } from "@/features/deliverables/deliverable-model";
import { withDeliverableChatStore } from "@/server/persistence/postgres/deliverable-chat-store";
import { withDeliverableProposalStore } from "@/server/persistence/postgres/deliverable-proposal-store";
import { coordinationPrompts } from "@/server/deliverables/coordination-prompts";
import { getStateStore } from "@/server/persistence/state-store";
import type { PortalState } from "@/state/portal-state";
import type { TranscriptRow } from "@openrhen/contracts";

const TRANSCRIPT_LIMIT = 30;
const FINISHED_STATUSES = new Set(["completed", ...CLOSED_STATUSES]);

/**
 * Everything an external coordinator (a CLI agent or desktop AI app driving `rhen deliverable
 * ...`) needs to work a deliverable, assembled server-side in one response because captured source
 * text lives in the proposal store, not in portal state. See the external coordination design note,
 * "API contract (the seam)", `GET /api/deliverables/[id]/pack`.
 */
export const GET = withRoute(
  "/api/deliverables/[id]/pack",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    try {
      const { id } = await params;
      const state = (await getStateStore().get()) as PortalState | null;
      const deliverable = state?.deliverables.find((item) => item.id === id);
      if (!state || !deliverable) return notFoundResponse("deliverable", id);

      const readiness = assessDeliverable({
        deliverable,
        situation: state.currentSituation,
        conditionDefinitions: state.conditionDefinitions,
        now: new Date(),
        commitments: state.commitments
      });
      const conditionNames = new Map(state.conditionDefinitions.map((entry) => [entry.id, entry.name]));
      const readinessByStepId = new Map(readiness.steps.map((entry) => [entry.stepId, entry]));
      const executable = new Set(readiness.executableStepIds);

      const [messages, coordination, sources] = await Promise.all([
        withDeliverableChatStore((store) => store.list(id)),
        withDeliverableChatStore((store) => store.coordinationState(id)),
        withDeliverableProposalStore((store) => store.packSources(id))
      ]);

      const titleById = new Map(state.deliverables.map((item) => [item.id, item.title]));
      const titleOfRef = new Map([
        ...state.projects.map((item) => [`project:${item.id}`, item.title] as const),
        ...state.deliverables.map((item) => [`deliverable:${item.id}`, item.title] as const),
        ...state.actions.map((item) => [`action:${item.id}`, item.title] as const)
      ]);
      const projectTitle = state.projects.find((item) => item.id === deliverable.projectId)?.title;
      const stepById = new Map(deliverable.steps.map((s) => [s.id, s]));
      const activeSession =
        state.activeSession?.targetType === "deliverable" && state.activeSession.targetId === id
          ? state.activeSession
          : null;

      const closed = FINISHED_STATUSES.has(deliverable.status) || deliverable.status === "awaiting_result";
      const eligible = !closed && readiness.executableStepIds.length > 0;
      const eligibilityReason = eligible
        ? undefined
        : deliverable.status === "awaiting_result"
          ? "Submitted and waiting on a result from outside."
          : closed
            ? `The deliverable is ${label(deliverable.status)}.`
            : !readiness.approved
              ? "The breakdown is not yet approved."
              : readiness.coverageFailures.length
                ? "The completion contract still has coverage gaps."
                : deliverable.steps.length === 0
                  ? "No steps are in the breakdown yet."
                  : "Every remaining step is blocked or waiting on something.";

      const transcript: TranscriptRow[] = messages.slice(-TRANSCRIPT_LIMIT).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        ...(message.meta ? { meta: message.meta } : {})
      }));

      const body = {
        generatedAt: new Date().toISOString(),
        timezone: state.settings.timezone,
        deliverable: {
          id: deliverable.id,
          title: deliverable.title,
          projectTitle,
          phase: phaseOf(deliverable),
          status: deliverable.status,
          details: deliverable.details,
          externalDeadlineAt: deliverable.externalDeadlineAt,
          internalDeadlineAt: deliverable.internalDeadlineAt,
          uncertainty: deliverable.uncertainty,
          importance: deliverable.importance,
          consequence: deliverable.consequence,
          completionThreshold: deliverable.completionThreshold,
          contractVersion: deliverable.contractVersion,
          planVersion: deliverable.planVersion,
          contractApprovedAt: deliverable.contractApprovedAt,
          planApprovedAt: deliverable.planApprovedAt,
          approvalNote: deliverable.approvalNote,
          submittedAt: deliverable.submittedAt ?? null,
          dependsOnDeliverableTitles: deliverable.dependencyIds
            .map((depId) => titleById.get(depId))
            .filter((title): title is string => Boolean(title)),
          // Prerequisites that are not deliverables: a project or an action.
          prerequisites: (deliverable.prerequisites ?? []).map((ref) => ({
            kind: ref.kind,
            id: ref.id,
            title: titleOfRef.get(`${ref.kind}:${ref.id}`) ?? ref.id
          }))
        },
        criteria: deliverable.criteria.map((item) => ({
          id: item.id,
          title: item.title,
          required: item.required,
          state: item.state,
          interpretation: item.interpretation,
          sourceDocument: item.sourceDocument,
          sourceLocation: item.sourceLocation,
          expectedEvidence: item.expectedEvidence,
          verificationMethod: item.verificationMethod,
          notes: item.notes,
          stepTitles: item.stepIds.map((stepId) => stepById.get(stepId)?.title).filter((t): t is string => Boolean(t))
        })),
        steps: deliverable.steps.map((item) => {
          const isExecutable = executable.has(item.id);
          const stepReadiness = readinessByStepId.get(item.id);
          return {
            id: item.id,
            title: item.title,
            status: item.status,
            required: item.required,
            expectedMinutes: item.expectedMinutes,
            remainingMinutes: item.remainingMinutes,
            optimisticMinutes: item.optimisticMinutes,
            pessimisticMinutes: item.pessimisticMinutes,
            energy: item.energy,
            completionCondition: item.completionCondition,
            details: item.details,
            completedAt: item.completedAt,
            dependsOnStepTitles: item.dependencyIds
              .map((depId) => stepById.get(depId)?.title)
              .filter((t): t is string => Boolean(t)),
            reblockOnComplete: item.reblockOnComplete,
            executable: isExecutable,
            ...(isExecutable
              ? {}
              : {
                  readiness: stepReadiness
                    ? stepReadinessText(stepReadiness, deliverable, conditionNames, state.settings.timezone)
                    : "Not available now"
                }),
            // The active session's stepSeconds is the ONLY persisted per-step time record in the system,
            // and it only exists while a session is running against this deliverable; 0 otherwise.
            recordedSeconds: activeSession?.stepSeconds?.[item.id] ?? 0
          };
        }),
        blockers: deliverable.blockers.map((item) => ({
          id: item.id,
          description: item.description,
          category: item.category,
          state: item.state,
          stepTitles: item.stepIds.map((stepId) => stepById.get(stepId)?.title).filter((t): t is string => Boolean(t)),
          proposedResolution: item.proposedResolution,
          resolutionNotes: item.resolutionNotes
        })),
        readiness: {
          coverageFailures: readiness.coverageFailures.map((failure) => coverageFailureText(failure)),
          executableStepIds: readiness.executableStepIds,
          eligible,
          ...(eligibilityReason ? { reason: eligibilityReason } : {})
        },
        session: activeSession
          ? {
              id: activeSession.id,
              status: activeSession.status,
              stepTitle: activeSession.stepId ? (stepById.get(activeSession.stepId)?.title ?? null) : null,
              plannedEndAt: activeSession.plannedEndAt,
              elapsedSeconds: activeSession.activeElapsedSeconds
            }
          : null,
        sources: sources.map((source) => ({
          id: source.id,
          title: source.title,
          sourceType: source.sourceType,
          capturedText: source.capturedText,
          capturedTextTruncated: source.capturedTextTruncated,
          files: source.files.map((file) => ({
            id: file.id,
            filename: file.filename,
            mimeType: file.mimeType,
            byteSize: file.byteSize,
            downloadPath: `/api/deliverable-source-files/${file.id}`
          }))
        })),
        transcript,
        coordination,
        prompts: coordinationPrompts({ title: deliverable.title, id: deliverable.id })
      };
      return Response.json(body);
    } catch (error) {
      log.setError(error);
      return Response.json(
        { error: error instanceof Error ? redact(error.message) : "The pack could not be assembled." },
        { status: 400 }
      );
    }
  }
);
