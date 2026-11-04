"use client";

/**
 * Four different things a panel can be saying at once: what went wrong, what an earlier import
 * achieved, where the current draft stands, and what a file gave up on the way in. They are separate
 * regions so a screen reader announces a failure as an alert and progress as polite status. The
 * banners are rendered beside the panel that raised them, so each instance is given only the
 * messages that belong to it and shows nothing at all when there are none.
 */
export function ImportStatusBanners({
  error,
  success = null,
  notice,
  warnings = []
}: {
  error: string;
  success?: { count: number; message: string } | null;
  notice: string;
  /** Findings about the file rather than a row — an ignored column, a sheet nothing read. Never blocking. */
  warnings?: readonly string[];
}) {
  return (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <section className="import-success" role="status" aria-live="polite">
          <span className="import-success-icon" aria-hidden="true">
            ✓
          </span>
          <div>
            <h2>Import successful</h2>
            <p>
              <strong>
                {success.count} record{success.count === 1 ? "" : "s"}
              </strong>{" "}
              imported. {success.message}
            </p>
            <small>The completed review has been cleared and this page is ready for another import.</small>
          </div>
        </section>
      )}
      {notice && (
        <p className="save-notice" role="status">
          {notice}
        </p>
      )}
      {warnings.length > 0 && (
        <section className="import-diagnostics" role="status">
          <strong>
            {warnings.length} thing{warnings.length === 1 ? "" : "s"} in the file{" "}
            {warnings.length === 1 ? "was" : "were"} ignored
          </strong>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <small>The records that were read are below; nothing here stops a commit.</small>
        </section>
      )}
    </>
  );
}
