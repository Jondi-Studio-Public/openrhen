"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { cx } from "@/components/ui/cx";
import { useState } from "react";
import type { ClientCapacityEnvelope } from "@/state/portal-provider";
import { Sheet } from "@/components/sheet";
import { Card } from "@/components/ui/card";
import { Meter } from "@/components/ui/stat";
import { formatMinutes } from "@/features/plan/plan-formatting";
import styles from "./time-ahead.module.css";

/** Hours to one decimal under a hundred, whole hours above: "35.6 h", "131 h". */
export const hoursText = (minutes: number) => {
  const hours = minutes / 60;
  return `${hours >= 100 ? Math.round(hours) : Math.round(hours * 10) / 10} h`;
};

/**
 * A band's name as a person says it: the first two bands by their week, the rest by the calendar
 * span they cover in the planning timezone ("11–26 Nov", "Nov to Jan").
 */
export function bandName(band: ClientCapacityEnvelope, timezone: string): string {
  if (band.kind === "detailed") return "Next 7 days";
  if (band.kind === "daily") return "The week after";
  // endsAt is exclusive, so the span's last day is the millisecond before it.
  const last = new Date(band.endsAt.getTime() - 1);
  const month = dateTimeFormat(displayLocale(), { timeZone: timezone, month: "short" });
  const day = dateTimeFormat(displayLocale(), { timeZone: timezone, day: "numeric" });
  const startMonth = month.format(band.startsAt);
  const endMonth = month.format(last);
  return startMonth === endMonth
    ? `${day.format(band.startsAt)}–${day.format(last)} ${endMonth}`
    : `${startMonth} to ${endMonth}`;
}

/** The share of a band's usable time already set aside for projects; 0 for a band with no time. */
const usedShare = (band: ClientCapacityEnvelope) =>
  band.adjustedCapacityMinutes ? band.reservedMinutes / band.adjustedCapacityMinutes : 0;

/**
 * Plan's Time ahead card: for each band of the next six months, how many hours are still free of the
 * time that can be counted on, with a meter of what is already set aside. The arithmetic behind it
 * (total time, what fixed things take, how much of a distant band is counted) opens in a sheet from
 * "How this is counted", so the card stays one figure per line. A phone shows the next 7 days and a
 * one-line rest.
 */
export function TimeAhead({ bands, timezone }: { bands: ClientCapacityEnvelope[]; timezone: string }) {
  const [explain, setExplain] = useState(false);
  if (!bands.length) return null;
  const [first, ...rest] = bands;
  return (
    <Card as="aside" padded className={styles.card} aria-labelledby="time-ahead-heading">
      <div>
        <h2 className={styles.title} id="time-ahead-heading">
          Time ahead
        </h2>
        <p className={styles.lead}>
          Free hours after sleep, shifts and fixed plans. Further out is counted more cautiously.
        </p>
      </div>
      <ul className={styles.bands}>
        {bands.map((band, index) => (
          <li key={band.kind} className={index === 0 ? styles.band : `${styles.band} ${styles.later}`}>
            <div className={styles.line}>
              <span className={styles.name}>{bandName(band, timezone)}</span>
              <span className={styles.figure}>
                <b>{hoursText(band.freeMinutes)}</b> free
                {index < 2 ? ` of ${hoursText(band.adjustedCapacityMinutes)}` : ""}
              </span>
            </div>
            <Meter
              className={cx(styles.meter)}
              value={usedShare(band)}
              label={`${bandName(band, timezone)}: share already set aside`}
            />
          </li>
        ))}
      </ul>
      {rest.length > 0 && first && (
        <p className={styles.phoneRest}>
          {rest
            .slice(0, 2)
            .map((band) => `${bandName(band, timezone)} ${hoursText(band.freeMinutes)}`)
            .join(" · ")}
        </p>
      )}
      <button type="button" className={styles.how} onClick={() => setExplain(true)}>
        How this is counted
      </button>
      <Sheet open={explain} onClose={() => setExplain(false)} title="How time ahead is counted">
        <p className={styles.sheetLead}>
          Actions get exact times only for the next 7 days. Further out, time is set aside roughly, and the further away
          it is, the less of it is counted on.
        </p>
        <ul className={styles.explain}>
          {bands.map((band) => (
            <li key={band.kind}>
              <p className={styles.name}>{bandName(band, timezone)}</p>
              <dl className={styles.figures}>
                <div>
                  <dt>Total time</dt>
                  <dd>{formatMinutes(band.rawCapacityMinutes)}</dd>
                </div>
                <div>
                  <dt>Taken by fixed plans</dt>
                  <dd>{formatMinutes(band.protectedKnownMinutes)}</dd>
                </div>
                <div>
                  <dt>Counted on ({Math.round(band.capacityFactor * 100)}%)</dt>
                  <dd>{formatMinutes(band.adjustedCapacityMinutes)}</dd>
                </div>
                <div>
                  <dt>Set aside for projects</dt>
                  <dd>{formatMinutes(band.reservedMinutes)}</dd>
                </div>
                <div>
                  <dt>Still free</dt>
                  <dd>{formatMinutes(band.freeMinutes)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </Sheet>
    </Card>
  );
}
