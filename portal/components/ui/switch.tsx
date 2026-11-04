"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cx } from "./cx";
import styles from "./switch.module.css";

/** An on/off setting that takes effect immediately. Name it with `label`; it is announced as a switch. */
export const Switch = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role" | "aria-checked" | "aria-label"> & {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
  }
>(function Switch({ checked, onChange, label, className, onClick, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx(styles.switch, checked && styles.on, className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onChange(!checked);
      }}
      {...rest}
    />
  );
});
