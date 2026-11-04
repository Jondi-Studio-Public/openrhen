"use client";

/** Renders one status choice, spelling the stored `snake_case` value as words. Used with `.map`. */
export function statusOption(value: string) {
  return (
    <option value={value} key={value}>
      {value.replace("_", " ")}
    </option>
  );
}
