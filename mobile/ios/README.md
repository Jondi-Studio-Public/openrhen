# OpenRhen for iOS

A thin native shell for the OpenRhen portal: the portal's web screens in a `WKWebView`, camera uploads through the page, place-change reporting to `POST /api/location/ping` (signed in by scanning a QR from the portal) and a day-6 re-sign reminder. A more native app is planned and will replace this shell.

It was moved here from a private repository in November 2026. That repository keeps the earlier history.

## Build

CI (the `iOS app` job in `.github/workflows/ci.yml`) runs `ci-build.sh`, which runs the host policy checks, generates the Xcode project with XcodeGen and builds an unsigned `.ipa` on a GitHub-hosted Mac. Download the `OpenRhen-unsigned-ipa` artifact from the run. To build locally on a Mac: `cd mobile/ios && xcodegen generate`, then open `OpenRhen.xcodeproj`. `./ci-build.sh` does all of it.

## Install (free developer account)

1. Install Sideloadly or AltServer, plug the phone in once and turn on Developer Mode.
2. Sideload the `.ipa` with your developer account, then trust the profile under Settings > General > VPN & Device Management.
3. Re-sign about every 6 days; the app reminds you on day 6.

## Setup in the app

Nothing is typed or pasted. On a portal where you are already signed in, open Devices and choose **Add a phone**. The portal shows a QR code with its https address printed under it. In the app, give the phone a name (it starts as the device model), tap **Scan the code** and allow the camera. The app first asks "Connect to *host*?" and only then redeems the code, so a QR from someone else's page cannot silently point your data at their server. The origin must be https, with a real name (not localhost, an IP address or a one-word name), or the app refuses it.

The portal then issues this phone its own owner token. It never expires and is revocable from the portal's Devices page; it can do less than a desk browser (it cannot add a phone or issue tokens). The app keeps the token, and a random lowercase install id that names the phone, in its own Keychain (readable after the first unlock, never copied to another device). Whether a Keychain group shared with extensions survives free signing is not yet known, so slice 1 uses the app's own Keychain behind the small `CredentialStore` protocol.

**No signed-in screen to hand?** Tap "Use a typed code instead", type the portal's https address, and the app shows an 8-letter code. On any signed-in portal open Devices, choose **Enter a code** and type it. Approve only a code shown on a phone in your hand. The app polls until you approve it (the standard device-code flow: it backs off on `slow_down` and stops on `expired_token` or `access_denied`).

Every `/api` call sends the token in `X-OpenRhen-Owner`. If the portal answers 401 (the phone was removed from Devices), the app signs out, clears its queue and web data and says "This phone was removed from the portal". The web view is locked to the paired origin (frames included) and signed in by exchanging the token for a web session at `POST /api/owner/web-session`; other links open in the system browser.

Location: allow Always. Place changes go to `POST /api/location/ping` with the same token and the install id as `device`, at most one every 30 seconds. A ping the portal cannot take is kept in a small queue (a JSON file in Application Support, protected until first unlock and excluded from device backups) and retried in order; a ping older than five minutes is dropped, never sent late, because the portal reads presence on receipt. `LOCATION_PING_TOKEN` is no longer used by the app (it stays for third-party collectors).

App Transport Security is at its default (https only, no exceptions).

## Checks

`Checks/main.swift` is compiled with the pure files in `Sources/` (listed in `ci-build.sh`) and run by CI. It covers QR parsing and validation (http, localhost, IP, version and missing-field refusals), the request and response contract, the device-code poll loop, the queue's ordering and expiry, and sign-out on a revoked token. The screens, camera, Keychain, location and web view cannot be exercised there.

## Limits, not yet verified on a phone

- The whole sign-in, scanner, Keychain, web-session cookie and location paths have only been written, not run on a phone; the pure logic is checked by `Checks/main.swift`.
- The web session is opened at launch and on Retry; the cookie lasts 30 days from last use, so a phone left closed for longer lands on the portal's sign-in page until the app is relaunched.
- Whether the Keychain item survives a re-sign, and whether a shared group works under free signing (the signing spike).
- Location reporting after a background relaunch.
- Whether a re-sign resets the app bundle's creation date; the reminder falls back to the first-launch date.
- Free signing cannot grant Time Sensitive notifications, so the reminder is an ordinary alert.
