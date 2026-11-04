import { z } from "zod";

/**
 * Agent time: the ingest contract an external client posts sessions in (schema
 * version 1), and the pure counting rules the Review line uses. Information only: nothing in the engine reads it.
 */

export const AGENT_SESSION_SCHEMA_VERSION = 1;
/** A call this long after an agent's last one opens a new calls session. */
export const AGENT_SESSION_IDLE_GAP_MINUTES = 30;
export const AGENT_SESSION_MAX_BATCH = 100;
export const AGENT_SESSION_MAX_SPAN_HOURS = 24;
/** How far past now a reported `endedAt` may sit, to forgive a client clock that runs a little fast. */
export const AGENT_SESSION_FUTURE_SLACK_MINUTES = 5;
/** Distinct route templates one calls session keeps; further ones count as `other`. */
export const AGENT_SESSION_MAX_TOUCHED = 25;

export const AGENT_SESSION_KINDS = ["conversation", "work", "other"] as const;
export type AgentSessionKind = (typeof AGENT_SESSION_KINDS)[number];

const timestamp = z.string().datetime({ offset: true });

/** One session a client reports. Unknown properties are ignored, so a client may grow ahead of this schema. */
export const reportedSessionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/, "id must be 1 to 128 characters of A-Z, a-z, 0-9, ., _, : or -.")
      .describe("The client's own id for this session; posting it again replaces the record."),
    startedAt: timestamp,
    endedAt: timestamp,
    kind: z.enum(AGENT_SESSION_KINDS).default("conversation"),
    title: z.string().trim().min(1).max(120).optional(),
    summary: z.string().trim().min(1).max(500).optional(),
    topics: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
    turns: z.number().int().min(0).max(100_000).optional()
  })
  .superRefine((session, context) => {
    const started = Date.parse(session.startedAt);
    const ended = Date.parse(session.endedAt);
    if (ended < started)
      context.addIssue({ code: "custom", path: ["endedAt"], message: "endedAt is before startedAt." });
    else if (ended - started > AGENT_SESSION_MAX_SPAN_HOURS * 3_600_000)
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: `A session lasts at most ${AGENT_SESSION_MAX_SPAN_HOURS} hours; split a longer one.`
      });
  });
export type ReportedSession = z.infer<typeof reportedSessionSchema>;

export const ingestAgentSessionsSchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_SCHEMA_VERSION),
  sessions: z.array(reportedSessionSchema).min(1).max(AGENT_SESSION_MAX_BATCH)
});
export type IngestAgentSessions = z.infer<typeof ingestAgentSessionsSchema>;

export type IngestStatus = "created" | "updated" | "unchanged";
export interface IngestResult {
  schemaVersion: typeof AGENT_SESSION_SCHEMA_VERSION;
  results: { id: string; status: IngestStatus }[];
}

/** Indexes of sessions whose `endedAt` is further in the future than a client clock should drift. */
export function sessionsFromTheFuture(sessions: readonly ReportedSession[], now: Date): number[] {
  const limit = now.getTime() + AGENT_SESSION_FUTURE_SLACK_MINUTES * 60_000;
  return sessions.flatMap((session, index) => (Date.parse(session.endedAt) > limit ? [index] : []));
}

/** Drops the long regex zod writes beside `format: date-time`; the format says it and clients read it better. */
export function withoutDatePatterns(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDatePatterns);
  if (node === null || typeof node !== "object") return node;
  const entries = Object.entries(node as Record<string, unknown>);
  const dateTime = entries.some(([key, value]) => key === "format" && value === "date-time");
  return Object.fromEntries(
    entries.filter(([key]) => !(dateTime && key === "pattern")).map(([key, value]) => [key, withoutDatePatterns(value)])
  );
}

/**
 * The JSON Schema published for client authors (`platform/contracts/agent-time-schema.v1.json`). It states each field's
 * shape; the rules that compare fields (end not before start, at most 24 hours, not in the future) are in the docs.
 */
export function agentSessionJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://openrhen.example/schemas/agent-sessions.v1.json",
    title: "OpenRhen agent sessions, version 1",
    ...(withoutDatePatterns(
      z.toJSONSchema(ingestAgentSessionsSchema, { io: "input", unrepresentable: "any" })
    ) as Record<string, unknown>)
  };
}

export interface TimedSession {
  agent: string;
  startedAt: Date;
  endedAt: Date;
  topics: readonly string[];
}

export interface AgentTimeSummary {
  windowStart: string;
  windowEnd: string;
  totalMinutes: number;
  agents: { agent: string; minutes: number; sessions: number }[];
  topics: { topic: string; minutes: number }[];
}

type Interval = readonly [number, number];

/** Milliseconds covered by the union of intervals; overlapping or touching ones count once. */
export function unionMs(intervals: readonly Interval[]): number {
  const sorted = [...intervals].filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let from = Number.NEGATIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const [start, end] of sorted) {
    if (start > to) {
      if (to > from) total += to - from;
      from = start;
      to = end;
    } else if (end > to) to = end;
  }
  return to > from ? total + (to - from) : total;
}

const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * Agent time inside a window. Each session is clipped to the window; the total is the union across every agent,
 * and an agent's own figure is the union of its sessions, so the figures per agent can add up to more than the
 * total when agents overlap. A topic is credited with the union of the sessions that name it.
 */
export function summariseAgentTime(
  sessions: readonly TimedSession[],
  windowStart: Date,
  windowEnd: Date
): AgentTimeSummary {
  const lo = windowStart.getTime();
  const hi = windowEnd.getTime();
  const clipped = sessions
    .map((session) => ({
      agent: session.agent,
      topics: session.topics,
      interval: [Math.max(lo, session.startedAt.getTime()), Math.min(hi, session.endedAt.getTime())] as Interval
    }))
    .filter(({ interval }) => interval[1] > interval[0]);
  const byAgent = new Map<string, Interval[]>();
  const byTopic = new Map<string, { label: string; intervals: Interval[] }>();
  for (const { agent, topics, interval } of clipped) {
    byAgent.set(agent, [...(byAgent.get(agent) ?? []), interval]);
    for (const topic of topics) {
      const key = topic.toLowerCase();
      const entry = byTopic.get(key) ?? { label: topic, intervals: [] };
      entry.intervals.push(interval);
      byTopic.set(key, entry);
    }
  }
  const agents = [...byAgent].map(([agent, intervals]) => ({
    agent,
    minutes: minutes(unionMs(intervals)),
    sessions: intervals.length
  }));
  agents.sort((a, b) => b.minutes - a.minutes || a.agent.localeCompare(b.agent));
  const topics = [...byTopic.values()].map(({ label, intervals }) => ({
    topic: label,
    minutes: minutes(unionMs(intervals))
  }));
  topics.sort((a, b) => b.minutes - a.minutes || a.topic.localeCompare(b.topic));
  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    totalMinutes: minutes(unionMs(clipped.map(({ interval }) => interval))),
    agents,
    topics: topics.slice(0, 5)
  };
}

/** `4h 10m`, `35m`, `2h`. */
export function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The one line Review shows. Says so plainly when nothing was recorded, so a silent week is not mistaken for a broken counter. */
export function agentTimeLine(summary: AgentTimeSummary, days = 7): string {
  const label = `Agent time, last ${days} days`;
  const top = summary.agents[0];
  if (summary.totalMinutes === 0 || !top) return `${label}: none recorded.`;
  const who =
    summary.agents.length === 1
      ? `${formatMinutes(summary.totalMinutes)} with ${top.agent}`
      : `${formatMinutes(summary.totalMinutes)}, mostly ${top.agent} (${formatMinutes(top.minutes)})`;
  const topic = summary.topics[0];
  return `${label}: ${who}${topic ? `; top topic: ${topic.topic}` : ""}.`;
}
