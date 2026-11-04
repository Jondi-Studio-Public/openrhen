import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cx } from "./cx";
import styles from "./chip.module.css";

/** A pill-shaped toggle for filters and choices. `pressed` is announced as aria-pressed. */
export const Chip = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean }>(
  function Chip({ pressed, className, type = "button", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-pressed={pressed}
        className={cx(styles.chip, pressed && styles.on, className)}
        {...rest}
      />
    );
  }
);
