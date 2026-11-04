"use client";

import { useEffect } from "react";

/**
 * The last-resort boundary: only rendered when the root layout itself throws, which means the layout
 * that would normally supply `<html>`, `<body>`, and `styles.css` is exactly what failed. This
 * replaces the root layout entirely rather than nesting inside it, so it defines its own `<html>` and
 * `<body>` and keeps its styling inline instead of depending on the stylesheet it cannot assume loaded.
 *
 * The colours below are a hand-copied subset of the token block in `styles.css` (`--bg`, `--ink`,
 * `--ink-muted`, `--accent-muted`, `--accent-fill`, `--accent-ink`), light and dark, kept in sync with
 * the same `prefers-color-scheme: dark` switch that stylesheet uses — this page can't `@import` it (the
 * whole point is it renders when that stylesheet may not have loaded), so the values are inlined
 * instead of referenced.
 */
const GLOBAL_ERROR_STYLES = `
  :root {
    --ge-bg: #f6f5f1;
    --ge-ink: #1d2924;
    --ge-ink-muted: #52615a;
    --ge-accent-muted: #4f7362;
    --ge-accent-fill: #235b46;
    --ge-accent-ink: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ge-bg: #101311;
      --ge-ink: #e9efeb;
      --ge-ink-muted: #b3c2bb;
      --ge-accent-muted: #72bd98;
      --ge-accent-fill: #2c6b51;
      --ge-accent-ink: #ffffff;
    }
  }
`;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <head>
        <meta name="color-scheme" content="light dark" />
        <style>{GLOBAL_ERROR_STYLES}</style>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--ge-bg)",
          color: "var(--ge-ink)",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
        }}
      >
        <main style={{ width: "min(560px, calc(100% - 48px))", padding: "40px 0" }}>
          <p
            style={{
              color: "var(--ge-accent-muted)",
              fontSize: "0.77rem",
              fontWeight: 800,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              margin: "0 0 8px"
            }}
          >
            Something went wrong
          </p>
          <h1 style={{ margin: "0 0 16px", fontSize: "clamp(1.8rem, 6vw, 2.6rem)", color: "var(--ge-ink)" }}>
            OpenRhen hit a snag.
          </h1>
          <p style={{ color: "var(--ge-ink-muted)", fontSize: "1.05rem", lineHeight: 1.65, margin: "0 0 28px" }}>
            Nothing was saved or lost — the app just failed to load. Try again, or reload the page if that doesn't help.
          </p>
          <button
            onClick={() => reset()}
            style={{
              minHeight: 46,
              border: 0,
              borderRadius: 999,
              padding: "12px 22px",
              background: "var(--ge-accent-fill)",
              color: "var(--ge-accent-ink)",
              fontWeight: 750,
              fontSize: "1rem",
              cursor: "pointer"
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
