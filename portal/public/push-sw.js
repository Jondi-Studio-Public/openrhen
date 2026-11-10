/*
 * Push-only service worker (the leave by push design note, "Portal surfaces", `layout.tsx`'s own
 * comment). No `fetch` handler and no cache: this worker exists solely to receive a push while the
 * app is closed and show the notification, never to serve a cached shell or answer offline. Registered
 * from the Settings -> Notifications page (`notifications-section.tsx`), not from `layout.tsx`.
 */

self.addEventListener("install", (_event) => {
  // Activate immediately rather than waiting for every open tab to close: there is no cached
  // version of anything for an old worker to keep serving, so there is nothing to protect by
  // waiting.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * The payload is exactly `leaveByPushPayloadSchema` (`platform/contracts/src/integrations/push.ts`):
 * `title`, `body`, `tag`, `url`, optional `renotify` and `checkInId` (a check-in waiting; the click opens `url`,
 * which shows the check-in on Now). `tag` is also the notification's replacement
 * key: a newer prompt for the same leg (`leaveByTag`) replaces an older one already showing rather
 * than stacking beside it. `renotify` (set for the at-leave-by and leave-earlier prompts) re-alerts
 * the person on that replacement instead of swapping the text silently — `tag` is always set, so
 * `renotify` is always valid alongside it.
 */
self.addEventListener("push", (event) => {
  let payload = { title: "OpenRhen", body: "", tag: "openrhen", url: "/now" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch  {
    // A malformed payload still shows something rather than showing nothing at all.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      renotify: Boolean(payload.renotify),
      data: { url: payload.url, checkInId: payload.checkInId || null },
      icon: "/icon-192.png",
      badge: "/icon-192.png"
    })
  );
});

/** Focuses an already-open tab on the target page rather than always opening a new one. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/now";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

/**
 * A key rotation invalidates every subscription on purpose:
 * this handler does not attempt to silently resubscribe with a new key, which would leave the person
 * unaware their device stopped receiving anything. It only tells the portal the old registration is
 * gone, so its row does not linger as a dead send target; the Notifications page then shows Off, and
 * turning it back on subscribes fresh under whatever key is current.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint;
  if (!oldEndpoint) return;
  event.waitUntil(
    fetch("/api/push/subscriptions", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: oldEndpoint })
    }).catch(() => {})
  );
});
