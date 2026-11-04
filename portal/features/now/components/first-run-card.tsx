/**
 * Now's hero before first setup has been done and before any plan exists: one way forward instead of
 * an empty page. A card rather than a redirect, so a database that has a plan but never ran setup
 * (setup was added after it) still opens on Now.
 */
export function FirstRunCard() {
  return (
    <div className="first-run-card">
      <p className="reason">
        Tell the planner when you sleep, when you last woke and where you are. It takes about a minute, and Now starts
        suggesting what to do next.
      </p>
      <a className="first-run-link" href="/setup">
        Start setup
      </a>
    </div>
  );
}
