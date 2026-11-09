import type { ListRowModel } from "../data-flow-model";
import styles from "./data-flow.module.css";

/**
 * The phone view (under 720 px): one row per entry, problems first. Each row has a dot, the status in words, the age and a
 * `from → via → to → reaches` chip strip, and opens the same panel the map does. No horizontal scroll.
 */
export function DataFlowList({ rows, onSelect }: { rows: readonly ListRowModel[]; onSelect: (id: string) => void }) {
  if (rows.length === 0) return <p className={styles.muted}>Nothing matches these filters.</p>;
  return (
    <ul className={styles.list} aria-label="Data sources, problems first">
      {rows.map((row) => (
        <li key={row.id} className={styles.row} data-planned={row.planned} data-tone={row.tone}>
          <button type="button" className={styles.rowButton} onClick={() => onSelect(row.id)}>
            <span className={styles.rowHead}>
              <span className={styles.dotHtml} data-tone={row.tone} aria-hidden="true" />
              <span className={styles.rowName}>{row.name}</span>
              <span className={styles.rowAge}>{row.detail}</span>
            </span>
            <span className={styles.chips} role="group" aria-label="From, via, to, reaches">
              {row.chips.map((chip, index) => (
                <span key={`${chip.kind}-${chip.text}-${index}`}>
                  {index > 0 ? <span className={styles.arrow}>→ </span> : null}
                  <span className={styles.chip} data-kind={chip.kind}>
                    {chip.text}
                  </span>
                </span>
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
