/**
 * The shape of Now's hero (an eyebrow, a two-line title, a card with its buttons) drawn in quiet
 * blocks, for the moments there is nothing true to show yet: the first state read, and a first plan
 * still being worked out. A screen reader hears only `label`.
 */
export function HeroSkeleton({ label }: { label: string }) {
  return (
    <div className="hero-skeleton" aria-busy="true">
      <p className="visually-hidden" role="status">
        {label}
      </p>
      <div aria-hidden="true">
        <span className="skeleton-bar skeleton-eyebrow" />
        <span className="skeleton-bar skeleton-title" />
        <span className="skeleton-bar skeleton-title short" />
        <div className="skeleton-card">
          <span className="skeleton-bar skeleton-line" />
          <span className="skeleton-bar skeleton-line short" />
          <span className="skeleton-buttons">
            <span className="skeleton-bar skeleton-button" />
            <span className="skeleton-bar skeleton-button" />
          </span>
        </div>
      </div>
    </div>
  );
}
