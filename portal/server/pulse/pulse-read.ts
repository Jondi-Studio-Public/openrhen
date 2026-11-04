import { pulseShares, type PulseSegment, type PulseWire } from "@openrhen/contracts";
import type { Sql } from "../persistence/postgres/sql-pool";

/**
 * `state.pulse`: the recorder's latest
 * judgement, read off the open `pulse_segments` row, the state machine's memory in `pulse_state`
 * and the last 30 days for the shares. Returns
 * `undefined` for a user the recorder has never evaluated (no open segment yet) — the wire field is
 * optional for exactly that reason.
 */
export async function readPulseState(
  sql: Sql,
  userId: string,
  now: Date,
  timeZone: string
): Promise<PulseWire | undefined> {
  const openRows = await sql<
    {
      started_at: Date;
      state: PulseWire["state"];
      reason: PulseWire["reason"];
      doing_kind: string | null;
      doing_id: string | null;
      doing_title: string | null;
      private: boolean;
      confirmed_at: Date | null;
    }[]
  >`
    SELECT started_at, state, reason, doing_kind, doing_id, doing_title, private, confirmed_at
    FROM pulse_segments WHERE user_id=${userId} AND ended_at IS NULL LIMIT 1
  `;
  const open = openRows[0];
  if (!open) return undefined;
  const memoryRows = await sql<
    { last_confirmed_at: Date | null; confirmed_by: string | null; silence_until: Date | null }[]
  >`
    SELECT last_confirmed_at, confirmed_by, silence_until FROM pulse_state WHERE user_id=${userId}
  `;
  const memory = memoryRows[0];
  const lastConfirmedAt = memory?.last_confirmed_at ?? open.confirmed_at;
  const silenceUntil =
    memory?.silence_until && memory.silence_until.getTime() > now.getTime() ? memory.silence_until : null;

  // The disruption holding `on/disrupted`: what he is doing instead, so status and the portal can say so.
  const disruptionRows =
    open.state === "on" && open.reason === "disrupted"
      ? await sql<
          {
            doing: string;
            until: Date;
            location_id: string;
            contexts: string[];
            exclusive: boolean;
            recorded_by: "person" | "agent";
          }[]
        >`
          SELECT doing, until, location_id, contexts, exclusive, recorded_by FROM pulse_disruptions
          WHERE user_id=${userId} AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1`
      : [];
  const disruption = disruptionRows[0];

  const since = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  const segmentRows = await sql<{ started_at: Date; ended_at: Date | null; state: string; reason: string | null }[]>`
    SELECT started_at, ended_at, state, reason FROM pulse_segments
    WHERE user_id=${userId} AND (ended_at IS NULL OR ended_at >= ${since})
    ORDER BY started_at
  `;
  const segments: PulseSegment[] = segmentRows.map((row) => ({
    startedAt: row.started_at,
    endedAt: row.ended_at,
    state: row.state as PulseSegment["state"],
    ...(row.reason ? { reason: row.reason as NonNullable<PulseSegment["reason"]> } : {})
  }));
  const shares = pulseShares(segments, now, timeZone);

  return {
    state: open.state,
    since: open.started_at.toISOString(),
    reason: open.reason,
    ...(open.doing_kind && open.doing_id
      ? {
          doing: {
            kind: open.doing_kind as NonNullable<PulseWire["doing"]>["kind"],
            id: open.doing_id,
            title: open.doing_title ?? ""
          }
        }
      : {}),
    ...(open.state === "off" && open.reason === "lapsed" ? { offReason: "lapsed" as const } : {}),
    private: open.private,
    ...(lastConfirmedAt ? { lastConfirmedAt: lastConfirmedAt.toISOString() } : {}),
    ...(memory?.confirmed_by === "person" || memory?.confirmed_by === "agent"
      ? { confirmedBy: memory.confirmed_by }
      : {}),
    ...(silenceUntil ? { silenceUntil: silenceUntil.toISOString() } : {}),
    ...(disruption
      ? {
          disruption: {
            doing: disruption.doing,
            until: disruption.until.toISOString(),
            locationId: disruption.location_id,
            contexts: disruption.contexts,
            exclusive: disruption.exclusive,
            recordedBy: disruption.recorded_by
          }
        }
      : {}),
    shares
  };
}
