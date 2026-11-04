import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import styles from "./icon-button.module.css";

/**
 * A square button that shows only an icon. The `label` is required because the icon alone tells a
 * screen reader nothing; it becomes the accessible name.
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> & { label: string; children: ReactNode }
>(function IconButton({ label, className, type = "button", children, ...rest }, ref) {
  return (
    <button ref={ref} type={type} aria-label={label} className={cx(styles.iconBtn, className)} {...rest}>
      {children}
    </button>
  );
});
