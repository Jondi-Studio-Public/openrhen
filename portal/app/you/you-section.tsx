import styles from "./you.module.css";

/** One labelled group on the You page; an extension's section uses the same wrapper. */
export function YouSection({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <section className={styles.group} aria-labelledby={`you-${id}`}>
      <h2 id={`you-${id}`} className={styles.label}>
        {label}
      </h2>
      {children}
    </section>
  );
}
