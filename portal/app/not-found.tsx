import Link from "next/link";

/**
 * Shown for any address that is not a page, instead of Next's bare default 404. It sits inside the root
 * layout, so the nav and tab bar are still there to move on with.
 */
export default function NotFound() {
  return (
    <main className="content-page">
      <p className="eyebrow">Not found</p>
      <h1>There is no page at this address.</h1>
      <p className="reason">The link may be old or mistyped. Your plan is untouched.</p>
      <div className="actions">
        <Link href="/">Go to Now</Link>
      </div>
    </main>
  );
}
