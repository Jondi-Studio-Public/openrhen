"use client";

import type { ReactNode } from "react";

/** The plain building blocks every settings panel is made of, beside the shared `Field`. */
export function Section({
  id,
  title,
  reason,
  featured = false,
  children
}: {
  /** Anchor the section index jumps to; omitted for panels that are not indexed. */
  id?: string;
  title: string;
  reason: string;
  featured?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className={featured ? "settings-section settings-section-featured" : "settings-section"}>
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          <p>{reason}</p>
        </div>
      </div>
      <div className="editor-grid settings-grid">{children}</div>
    </section>
  );
}

export function ContextChoices({
  options,
  selected,
  onChange
}: {
  options: string[];
  selected: string[];
  onChange: (contexts: string[]) => void;
}) {
  return (
    <div className="choice-list">
      {options.map((context) => (
        <label key={context}>
          <input
            type="checkbox"
            checked={selected.includes(context)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...new Set([...selected, context])]
                  : selected.filter((item) => item !== context)
              )
            }
          />
          <span>{context}</span>
        </label>
      ))}
    </div>
  );
}

export function MinuteInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <input
      type="number"
      min="0"
      max="1440"
      step="1"
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}

export function HourInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <input
      type="number"
      min="1"
      max="16"
      step="0.25"
      value={value / 60}
      onChange={(event) => onChange(Math.round(Number(event.target.value) * 60))}
    />
  );
}

export function PercentInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <div className="input-suffix">
      <input
        type="number"
        min="0"
        max="100"
        value={Math.round(value * 100)}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
      />
      <span>%</span>
    </div>
  );
}
