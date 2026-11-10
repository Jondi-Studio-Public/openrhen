# OpenRhen for iOS

A native app for the OpenRhen portal. The day itself is native (Now, Day, check-ins, session controls, Sources); planning stays in the portal's web screens, shown in a `WKWebView` in the Plan tab. It also does camera uploads through the page, place-change reporting to `POST /api/location/ping` (signed in by scanning a QR from the portal) and a day-6 re-sign reminder.

It was moved here from a private repository in November 2026. That repository keeps the earlier history.

## Build

CI (the `iOS app` job in `.github/workflows/ci.yml`) runs `ci-build.sh`, which runs the host policy checks, generates the Xcode project with XcodeGen and builds an unsigned `.ipa` on a GitHub-hosted Mac. Download the `OpenRhen-unsigned-ipa` artifact from the run. To build locally on a Mac: `cd mobile/ios && xcodegen generate`, then open `OpenRhen.xcodeproj`. `./ci-build.sh` does all of it.

## Install (free developer account)

1. Install Sideloadly or AltServer, plug the phone in once and turn on Developer Mode.
2. Sideload the `.ipa` with your developer account, then trust the profile under Settings > General > VPN & Device Management.
3. Re-sign about every 6 days; the app reminds you on day 6.

## Setup in the app

Nothing is typed or pasted. On a portal where you are already signed in, open Devices and choose **Add a phone**. The portal shows a QR code with its https address printed under it. In the app, give the phone a name (it starts as the device model), tap **Scan the code** and allow the camera. The app first asks "Connect to *host*?" and only then redeems the code, so a QR from someone else's page cannot silently point your data at their server. The origin must be https, with a real name (not localhost, an IP address or a one-word name), or the app refuses it.

The portal then issues this phone its own owner token. It never expires and is revocable from the portal's Devices page; it can do less than a desk browser (it cannot add a phone or issue tokens). The app keeps the token, the credential's id, and a random lowercase install id that names the phone, in its own Keychain (readable after the first unlock, never copied to another device). Whether a Keychain group shared with extensions survives free signing is not yet known, so slice 1 uses the app's own Keychain behind the small `CredentialStore` protocol. Removing the phone from the app first revokes its own credential with `DELETE /api/owner/credentials/{id}`; if the portal cannot be reached (or does not confirm), the app still signs out and says the phone stays listed on the Devices page until it is removed there.

**No signed-in screen to hand?** Tap "Use a typed code instead", type the portal's https address, and the app shows an 8-letter code. On any signed-in portal open Devices, choose **Enter a code** and type it. Approve only a code shown on a phone in your hand. The app polls until you approve it (the standard device-code flow: it backs off on `slow_down` and stops on `expired_token` or `access_denied`).

Every `/api` call sends the token in `X-OpenRhen-Owner`. If the portal answers 401 (the phone was removed from Devices), the app signs out, clears its queue and web data and says "This phone was removed from the portal". The web view is locked to the paired origin (frames included) and signed in by exchanging the token for a web session at `POST /api/owner/web-session`; other links open in the system browser.

Location: allow Always. Place changes go to `POST /api/location/ping` with the same token and the install id as `device`, at most one every 30 seconds. A ping the portal cannot take is kept in a small queue (a JSON file in Application Support, protected until first unlock and excluded from device backups) and retried in order; a ping older than five minutes is dropped, never sent late, because the portal reads presence on receipt. `LOCATION_PING_TOKEN` is no longer used by the app (it stays for third-party collectors).

App Transport Security is at its default (https only, no exceptions).

## Living the day (native screens)

Signed in, the app opens on four tabs: **Now**, **Day**, **Plan** (the portal's own screens) and **Sources**.

- **Now** shows the current recommendation and why, the time left, the leave-by line and the place suggestion the server offers. A waiting check-in opens its sheet once; "Not now" is not asked again.
- **Check-in sheet.** Yes, on it / No, I'm doing... / Not sure, with free words on any answer (up to 8000 characters) and no list of reasons. The app calls `POST /api/check-ins/{id}/shown` when the sheet actually opens. The answer is `answer_check_in` with `answerSource: "app"`.
- **Session controls.** Start (the Now directive, when it is an ordinary task), Pause, Resume, Done and Stop for now go through the ordinary `/api/commands/session` and `/activity` commands. "Stop for now" asks in words how much is left; if no minutes can be read from the words it asks once more, then sends the words with no minutes (outcome `unsure`) rather than a guess.
- **Day** lists the rest of today in the plan's time zone (not the phone's; it says so when they differ). "Changed by" shows when an entry carries it.
- **Cache.** The last view is kept on the phone (`client-view.json`, protected and excluded from backups) and shown as "as of 09:05"; past its `validUntil` or 15 minutes old it is dimmed. Signing out deletes it.
- **Keeping current.** Pull to refresh, refresh on coming to the foreground, and `GET /api/events` (the server's event stream) held open while the app is in front: each `hello` or `changed` event triggers a conditional refetch of the view (`If-None-Match`). If the stream cannot connect the app polls every 60 seconds; a slow poll also backs the stream. Nothing runs while the app is closed.
- **Outbox.** Every command is written to an on-device queue (`command-outbox.json`) before it is sent, and sent one at a time in the order made, across all sessions and check-ins, each with `occurredAt` (ISO 8601 with the phone's offset) and its `commandId` kept across retries. A network error or 5xx backs off (5 s doubling to 5 min) and keeps the order. A refusal (409 or another 4xx) holds that command and the later ones on the same session; the Sources screen offers Try again or Drop in words, and other sessions keep going. When the server applied a command at receipt time instead of the time claimed, its sentence ("Recorded at ..., when the server received it, because ...") is shown. An offline check-in answer sends `expectedVersion: null`; if the check-in had closed, the app says "Not delivered: the check-in closed while you were offline" and your words were kept as a note on the server.
- **Versions.** Just before the first command on a session the app fetches the client view afresh (no cached tag) and names `pending.session.version` (pause, resume, finish) or the action directive's `expectedVersion` (start), but only if the session is still as you left it (otherwise the command is held with "the session is now paused, not running as you left it"). It no longer reads `GET /api/state`. Later queued commands on the same session take the version from the previous reply, so the app never conflicts with itself.

The pure logic (decoding, cache freshness, words, the outbox, the session projection, the event parser) is in Foundation-only files compiled by `ci-build.sh`; `Checks/main.swift` decodes every fixture in `platform/contracts/client-view-fixtures.v1.json` with the Swift types and fails on a mismatch. The SwiftUI views are thin.

## Checks

`Checks/main.swift` is compiled with the pure files in `Sources/` (listed in `ci-build.sh`) and run by CI, with the paths of the client view fixtures and schema. It covers QR parsing and validation (http, localhost, IP, version and missing-field refusals), the request and response contract, the device-code poll loop, the location queue's ordering and expiry, sign-out on a revoked token, the client view contract (every fixture decodes), the cache and its words, the event-stream parser, the command outbox (order, backoff, holds, version chaining, replies in words) and the session flow. The screens, camera, Keychain, location and web view cannot be exercised there.

## Limits, not yet verified on a phone

- The native screens, the event stream and the outbox runner have not been compiled or run on a phone; only the pure files are checked on the runner.
- No background refresh and no local notifications yet (slice 3): a waiting check-in is shown only while the app is open.
- The place suggestion card is read-only: confirm the place in the Plan tab. Planning questions (`needs`) are listed and answered in the Plan tab.
- The "Changed for you" list is slice 2b; "changed by" on the Day screen shows only when the server sends it.

- The whole sign-in, scanner, Keychain, web-session cookie and location paths have only been written, not run on a phone; the pure logic is checked by `Checks/main.swift`.
- The web session is opened at launch and on Retry; the cookie lasts 30 days from last use, so a phone left closed for longer lands on the portal's sign-in page until the app is relaunched.
- Whether the Keychain item survives a re-sign, and whether a shared group works under free signing (the signing spike).
- Location reporting after a background relaunch.
- Whether a re-sign resets the app bundle's creation date; the reminder falls back to the first-launch date.
- Free signing cannot grant Time Sensitive notifications, so the reminder is an ordinary alert.
