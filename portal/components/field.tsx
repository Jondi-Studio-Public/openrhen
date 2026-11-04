"use client";

import type { ReactNode } from "react";

/**
 * One labelled control in an editor grid. `wide` lets a control span the grid instead of a column.
 *
 * `group` is for a set of controls rather than a single one — a list of checkboxes, say. A `<label>`
 * wrapping several checkboxes hands its whole text to the first of them as that checkbox's
 * accessible name, so a group renders `<fieldset><legend>` instead: the legend names the set, and
 * every checkbox keeps the name of its own label.
 */
export function Field({
  label,
  wide = false,
  group = false,
  children
}: {
  label: ReactNode;
  wide?: boolean;
  group?: boolean;
  children: ReactNode;
}) {
  const className = wide ? "field wide" : "field";
  if (group)
    return (
      <fieldset className={className}>
        <legend>{label}</legend>
        {children}
      </fieldset>
    );
  return (
    <label className={className}>
      <span>{label}</span>
      {children}
    </label>
  );
}
