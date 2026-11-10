# Web push

You need this when you want leave-by reminders and check-in prompts on your phone.

Leave-by reminders reach a phone through standard Web Push: the sender signs each message with a VAPID key (RFC 8292) and encrypts the payload (RFC 8291). The code is hand-written on Node `crypto` inside the outbound proxy, with no push library. The proxy holds the one key pair; the portal only fetches the public half from it.

## 1. Generate the key pair

```text
node integrations/outbound-proxy/scripts/generate-vapid-keys.mjs
```

Paste its three lines into the **outbound proxy's** environment (`.env`), never the portal's:

```text
WEB_PUSH_VAPID_PUBLIC_KEY=<generated>
WEB_PUSH_VAPID_PRIVATE_KEY=<generated>
WEB_PUSH_SUBJECT=mailto:you@example.com
```

`WEB_PUSH_SUBJECT` is the contact a push service can reach if it needs to reach the sender; use an address you read. Restart the proxy afterwards (`docker compose up -d outbound-proxy`). With any of the three unset, the proxy answers 503 for the public key and Settings > Notifications reports the service unreachable.

## 2. Install the portal to the Home Screen (iOS)

iOS only delivers push to an app installed to the Home Screen; a Safari tab never receives one. In Safari open the portal, tap **Share**, then **Add to Home Screen**, and launch it from the new icon. The Notifications page refuses to offer the switch until it sees the installed app. Android and desktop browsers with push support skip this step. Push needs an https origin outside localhost.

## 3. Turn it on for a device

Settings > Notifications > **Turn on for this device** registers the service worker, asks permission and subscribes with the proxy's current public key. At most five devices can be subscribed. Adding a device queues a "New device added" notice to the others, so an unexpected device stands out. **Send a test** pushes one notification to every subscribed device. **Remind me before leaving (minutes)** sets the lead time of the reminder before a commitment's leave-by moment.

**Check-in prompts.** When the check-in scheduler asks "Still on X?" it also queues one push for that check-in (dedupe key `check-in:<id>`, expiring when the check-in times out). Nothing is queued while you are asleep, under a silent commitment, or when there is nothing to ask about. The push counts as the prompt only once a device reports it sent: that is when the check-in's timeout starts, so a push that never reached a device does not use up the answering window. Answering the check-in, or its timing out or being replaced, withdraws a push still waiting. Tapping it opens `/now`, which shows the check-in.

## 4. Confirm it worked

A successful test shows a notification naming the portal; tapping it opens `/now`. The device list shows each device's last successful delivery.

## Troubleshooting

- **The page says the push service is not reachable**: one of the three `WEB_PUSH_*` variables is unset on the proxy, or the proxy is down.
- **"Add to Home Screen first" never goes away**: relaunch from the Home Screen icon, not from a browser tab.
- **A device shows blocked**: notification permission was denied in the browser's own site settings; re-enable it there and reload.
- **A device stopped receiving pushes**: a key rotation invalidates old subscriptions on purpose. The device shows as off; turn it back on to subscribe under the new key.
