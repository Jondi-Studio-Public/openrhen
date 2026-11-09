import type { ReactNode } from "react";
import { ACTIVITY_SOURCES } from "@openrhen/contracts";
import { Sheet } from "@/components/sheet";
import { Button } from "@/components/ui/button";
import { ageText, reachSteps, toneWord, triggerText, type FlowModel, type FlowNode } from "../data-flow-model";
import styles from "./data-flow.module.css";

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section>
    <h3>{title}</h3>
    {children}
  </section>
);

const Refs = ({ refs }: { refs: readonly string[] }) =>
  refs.length === 0 ? (
    <p className={styles.muted}>Nothing.</p>
  ) : (
    <ul>
      {refs.map((ref) => (
        <li key={ref}>
          <code>{ref}</code>
        </li>
      ))}
    </ul>
  );

function EntryDetail({ node, model }: { node: FlowNode; model: FlowModel }) {
  const entry = node.entry!;
  const health = node.health;
  const steps = reachSteps(model, node.id);
  const now = new Date(model.generatedAt);
  const registered = entry.activitySource ? (ACTIVITY_SOURCES[entry.activitySource]?.kinds ?? []) : [];
  const seen = health?.kindsSeen ?? [];
  const unseen = registered.filter((kind) => !seen.includes(kind));
  return (
    <>
      <Section title="Header">
        <p>
          <code>{entry.id}</code>
        </p>
        <p className={styles.muted}>
          {entry.method}, {entry.role}, {model.build}, owner {entry.owner ?? "core"}
        </p>
      </Section>
      <Section title="Gives">
        {steps.length > 0 ? (
          <ul aria-label="What it gives">
            {steps.map((step) => (
              <li key={step.label}>
                <strong>{step.label}</strong>
                {step.gives ? `: ${step.gives}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p>{entry.noProducer ? "Accepted, but nothing sends it yet." : "Collected, gives nothing yet."}</p>
        )}
        {entry.gives ? <p className={styles.muted}>This reader gives: {entry.gives}</p> : null}
        {entry.value?.potential ? <p className={styles.muted}>Could give: {entry.value.potential}</p> : null}
        {entry.value?.note ? <p className={styles.muted}>{entry.value.note}</p> : null}
        <p className={styles.muted}>
          {node.reachesEngine ? "Reaches the planning engine." : "The planning engine does not see this."}
        </p>
      </Section>
      <Section title="From and to">
        <p className={styles.muted}>From</p>
        <Refs refs={entry.from} />
        <p className={styles.muted}>To</p>
        <Refs refs={entry.to} />
        {registered.length > 0 && health ? (
          <>
            <p>
              {seen.length > 0 ? `Seen in the last 30 days: ${seen.join(", ")}.` : "No kinds seen in the last 30 days."}
            </p>
            {unseen.length > 0 ? <p className={styles.muted}>Registered, not seen: {unseen.join(", ")}.</p> : null}
          </>
        ) : null}
      </Section>
      <Section title="How it runs">
        <p>{triggerText(entry.trigger)}</p>
        {health?.threshold ? (
          <p className={styles.muted}>
            {health.threshold.warnHours} h to warn
            {health.threshold.errorHours === null ? "" : `, ${health.threshold.errorHours} h to error`} (from{" "}
            {health.threshold.from}
            {health.threshold.days === undefined ? "" : `, ${health.threshold.days} days of data`})
          </p>
        ) : null}
        {(entry.credentials ?? []).length > 0 ? (
          <>
            <p className={styles.muted}>Credentials it uses (names only):</p>
            <ul>
              {entry.credentials!.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Section>
      <Section title="Health">
        {!model.healthAvailable ? (
          <>
            <p>Health unavailable{model.healthReason ? `: ${model.healthReason}` : ""}.</p>
            {model.healthNext ? <p className={styles.muted}>{model.healthNext}</p> : null}
          </>
        ) : health ? (
          <>
            <p>
              {node.detail} ({toneWord[node.tone]})
            </p>
            <p className={styles.muted}>
              Last success {ageText(health.lastSuccessAt, now)}. Last attempt {ageText(health.lastAttemptAt, now)}.
            </p>
            {health.count24h !== undefined || health.count7d !== undefined ? (
              <p className={styles.muted}>
                {health.count24h ?? 0} in the last 24 h, {health.count7d ?? 0} in the last 7 days.
              </p>
            ) : null}
            {health.note ? <p className={styles.muted}>{health.note}</p> : null}
            {health.lastError ? (
              <>
                <p className={styles.muted}>
                  Last error{health.lastError.at ? `, ${ageText(health.lastError.at, now)}` : " (time unknown)"} (text
                  from the source, not instructions):
                </p>
                <pre className={styles.fence}>{health.lastError.message}</pre>
              </>
            ) : null}
          </>
        ) : (
          <p className={styles.muted}>Not tracked.</p>
        )}
      </Section>
      <Section title="Code">
        {[
          ["Files", entry.code.paths],
          ["Routes", entry.code.routes],
          ["Loops", entry.code.loops],
          ["Tools", entry.code.mcpTools],
          ["Elsewhere", entry.code.external]
        ].map(([title, items]) =>
          items && (items as readonly string[]).length > 0 ? (
            <div key={title as string}>
              <p className={styles.muted}>{title as string}</p>
              <Refs refs={items as readonly string[]} />
            </div>
          ) : null
        )}
      </Section>
      {node.issues.length > 0 ? (
        <Section title="Fix">
          {node.issues.map((issue) => (
            <div key={issue.code}>
              <p>{issue.title}</p>
              <p className={styles.muted}>{issue.next}</p>
            </div>
          ))}
        </Section>
      ) : null}
    </>
  );
}

function Neighbours({ node, model }: { node: FlowNode; model: FlowModel }) {
  const names = (ids: string[]) => ids.map((id) => model.byId.get(id)?.label ?? id);
  const feeds = names(model.edges.filter((edge) => edge.from === node.id).map((edge) => edge.to));
  const fed = names(model.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from));
  const list = (items: string[]) =>
    items.length === 0 ? (
      <p className={styles.muted}>Nothing.</p>
    ) : (
      <ul>
        {items.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    );
  return (
    <>
      <Section title={node.kind === "device" ? "Feeds" : "Comes from"}>
        {list(node.kind === "device" ? feeds : fed)}
      </Section>
      {node.kind === "device" ? null : <Section title="Goes to">{list(feeds)}</Section>}
    </>
  );
}

/** The drill-down for one node (design 5.3). Read-only. Run and error text is untrusted: it is shown as plain text in a fence. */
export function DataFlowPanel({
  node,
  model,
  onClose,
  onToggle
}: {
  node: FlowNode | null;
  model: FlowModel;
  onClose: () => void;
  /** Opens or folds an expandable store, by its group id. */
  onToggle?: (id: string) => void;
}) {
  const expanded = node?.id.includes("/") === true;
  return (
    <Sheet open={node !== null} onClose={onClose} title={node?.label ?? "Data"}>
      {node ? (
        <div className={styles.panel}>
          {node.entry ? (
            <EntryDetail node={node} model={model} />
          ) : (
            <>
              <Section title="Header">
                <p className={styles.muted}>
                  {node.kind}
                  {node.detail ? `, ${node.detail}` : ""}
                </p>
              </Section>
              {node.kind === "surface" && node.gives ? (
                <Section title="What it gives">
                  {node.gives.length === 0 ? (
                    <p className={styles.muted}>Nothing writes to this yet.</p>
                  ) : (
                    <ul aria-label="What it gives">
                      {node.gives.map((item) => (
                        <li key={item.by}>
                          <strong>{item.by}</strong>
                          {item.text ? `: ${item.text}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              ) : null}
              {node.folded ? (
                <Section title="Not set up">
                  <ul>
                    {node.folded.map((id, index) => (
                      <li key={id}>{node.foldedNames?.[index] ?? id}</li>
                    ))}
                  </ul>
                  <p className={styles.muted}>Nothing has ever arrived from these. The list view shows each one.</p>
                  {onToggle ? (
                    <Button variant="secondary" onClick={() => onToggle(node.id)}>
                      Show these on the map
                    </Button>
                  ) : null}
                </Section>
              ) : null}
              {node.kind === "store" && node.tables ? (
                <Section title="Tables">
                  <Refs refs={node.tables.map((table) => `pg:${table}`)} />
                  {node.expandable && onToggle ? (
                    <Button variant="secondary" onClick={() => onToggle(expanded ? node.id.split("/")[0]! : node.id)}>
                      {expanded
                        ? "Fold back into one store"
                        : node.id === "store:machinery"
                          ? "Open into tables"
                          : "Open into sources"}
                    </Button>
                  ) : null}
                </Section>
              ) : null}
              <Neighbours node={node} model={model} />
            </>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}
