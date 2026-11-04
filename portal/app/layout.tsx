import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./styles.css";
import "@/features/disruptions/disruptions.css";
import "@/features/check-in/check-in.css";
import "@/features/now/now.css";
import "@/features/planning/planning.css";
import "@/features/plan/plan.css";
import "@/features/imports/imports.css";
import "@/features/settings/settings.css";
import "@/features/routines/routines.css";
import "@/features/commitments/commitments.css";
import "@/features/deliverables/deliverables.css";
import "@/features/inbox/inbox.css";
import "@/features/today/today.css";
import "@/features/schedule/schedule.css";
import "@/features/history/history.css";
import "@/features/review/review.css";
import "@/features/capture/capture.css";
import "@/features/plan-map/plan-map.css";
import "@/features/catch-up/catch-up.css";
import "@/features/doctor/doctor.css";
import { PortalProvider } from "@/state/portal-provider";
import { AppShell } from "../components/app-shell";

/**
 * `themeColor` matches the page background in `styles.css`, so the browser chrome and the page do
 * not meet at a visible seam. There are two of them because the stylesheet follows the system
 * light/dark preference: each value is the `--bg` token for that scheme, and they must be changed
 * together with it. There is no in-app theme switch, so `colorScheme` simply declares that both
 * are supported and lets the browser pick.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f1" },
    { media: "(prefers-color-scheme: dark)", color: "#101311" }
  ],
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  // Chrome on Android then shrinks the layout for the keyboard, so the capture sheet (sized in dvh)
  // rises above it. iOS Safari ignores this; there the sticky Add bar keeps the button reachable.
  interactiveWidget: "resizes-content"
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  return {
    metadataBase: base,
    title: "OpenRhen",
    description: "Know what to work on now.",
    applicationName: "OpenRhen",
    icons: {
      icon: [
        { url: "/icon.svg", type: "image/svg+xml" },
        { url: "/icon-192.png", type: "image/png", sizes: "192x192" }
      ],
      apple: "/icon-192.png"
    },
    openGraph: {
      title: "OpenRhen",
      description: "Know what to work on now."
    },
    twitter: {
      card: "summary",
      title: "OpenRhen",
      description: "Know what to work on now."
    }
  };
}

/**
 * The portal is used from a phone as an installed app, so it declares a web app manifest and the
 * Apple equivalents. These are written as elements rather than through `generateMetadata`, because
 * this layout's metadata is asynchronous and vinext streams asynchronous metadata into the body:
 * Chrome only reads `rel="manifest"` from a direct child of `<head>`, which is where React hoists
 * these. There is a push-only service worker (`public/push-sw.js`, registered from the Settings →
 * Notifications page, not here), never a cache — the portal is useless without its database, and a
 * cached shell would only hide that. It exists solely to receive a push while the app is closed and
 * show the notification; it has no `fetch` handler and answers nothing offline.
 *
 * The manifest carries a single `theme_color`/`background_color`, with no way to vary them by
 * colour scheme, so both stay on the light `--bg`. That only shows in the install splash; once the
 * document is parsed the two `themeColor` metas above take over the browser chrome. The Apple
 * status bar style has the same limitation and the same resolution — `black-translucent` is the
 * only dark option and it pulls content under the status bar, which this layout is not built for.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <link rel="manifest" href="/manifest.webmanifest" />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-title" content="OpenRhen" />
      <meta name="apple-mobile-web-app-status-bar-style" content="default" />
      <body>
        <PortalProvider>
          <AppShell>{children}</AppShell>
        </PortalProvider>
      </body>
    </html>
  );
}
