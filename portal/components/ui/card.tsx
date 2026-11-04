import type { ElementType, HTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "./cx";
import styles from "./card.module.css";

/**
 * The surface a group of related content sits on. Render it as a different element with `as`
 * (section, article, li). Leave `padded` off when the content is a list of rows that run edge to edge.
 */
export function Card({
  as: Tag = "div",
  padded = false,
  className,
  ...rest
}: HTMLAttributes<HTMLElement> & { as?: ElementType; padded?: boolean; ref?: Ref<HTMLElement> }) {
  return <Tag className={cx(styles.card, padded && styles.padded, className)} {...rest} />;
}

/** The top strip of a {@link Card}: a heading on the left, an optional control or link on the right. */
export function CardHeader({
  title,
  as: Heading = "h2",
  trailing,
  className
}: {
  title: ReactNode;
  as?: "h2" | "h3" | "h4";
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.head, className)}>
      <Heading className={styles.title}>{title}</Heading>
      {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
    </div>
  );
}
