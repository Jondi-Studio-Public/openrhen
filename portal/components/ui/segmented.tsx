"use client";

import { useRef, type KeyboardEvent } from "react";
import { cx } from "./cx";
import styles from "./segmented.module.css";

export type SegmentedOption<T extends string> = { value: T; label: string };

/**
 * A compact choice of one among a few, such as a day / week switch. It is a radio group: only the
 * selected option is in the tab order, and the arrow keys move the selection (and focus) to the
 * neighbouring option, wrapping at the ends.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label?: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.findIndex((o) => o.value === value);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0 || options.length === 0) return;
    event.preventDefault();
    const next = (Math.max(selected, 0) + step + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} className={cx(styles.seg, className)} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (selected === -1 && index === 0) ? 0 : -1}
            className={cx(styles.opt, checked && styles.on)}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
