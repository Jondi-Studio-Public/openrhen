import Link from "next/link";
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes } from "react";
import { cx } from "./cx";
import styles from "./button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

type LookProps = {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  block?: boolean | undefined;
  /** Lets a long label take more than one line on a narrow screen instead of overflowing. */
  wrap?: boolean | undefined;
};

function look(
  { variant = "secondary", size = "md", block = false, wrap = false }: LookProps,
  className?: string | undefined
): string {
  return cx(styles.btn, styles[variant], styles[size], block && styles.block, wrap && styles.wrap, className);
}

/**
 * The one button every screen uses. Primary is the single main action on a view, secondary the
 * default, ghost for low-key actions and danger for ones that destroy something. It presses in
 * slightly under the finger, except under prefers-reduced-motion. Defaults to type="button" so it
 * never submits a form by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & LookProps>(
  function Button({ variant, size, block, wrap, className, type = "button", ...rest }, ref) {
    return <button ref={ref} type={type} className={look({ variant, size, block, wrap }, className)} {...rest} />;
  }
);

/** A link that looks exactly like a {@link Button}, for actions that navigate. */
export const ButtonLink = forwardRef<
  HTMLAnchorElement,
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & LookProps & { href: string }
>(function ButtonLink({ variant, size, block, wrap, className, href, ...rest }, ref) {
  return (
    <Link ref={ref} href={href} className={look({ variant, size, block, wrap }, className)} {...(rest as object)} />
  );
});
