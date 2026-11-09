# OpenRhen for iOS

A thin native shell for the OpenRhen portal: the portal's web screens in a `WKWebView`, camera uploads through the page, place-change reporting to `POST /api/location/ping` and a day-6 re-sign reminder. A more native app is planned and will replace this shell.

It was moved here from a private repository in November 2026. That repository keeps the earlier history.

## Build

CI (the `iOS app` job in `.github/workflows/ci.yml`) runs `ci-build.sh`, which runs the host policy checks, generates the Xcode project with XcodeGen and builds an unsigned `.ipa` on a GitHub-hosted Mac. Download the `OpenRhen-unsigned-ipa` artifact from the run. To build locally on a Mac: `cd mobile/ios && xcodegen generate`, then open `OpenRhen.xcodeproj`. `./ci-build.sh` does all of it.

## Install (free Apple ID)

1. Install Sideloadly or AltServer, plug the iPhone in once and turn on Developer Mode.
2. Sideload the `.ipa` with your Apple ID, then trust the profile under Settings > General > VPN & Device Management.
3. Re-sign about every 6 days; the app reminds you on day 6.

## Setup in the app

Enter your portal address and tap Save address. It must be `https://...`; plain http is refused. The web view is locked to that origin (frames included) and other links open in Safari. For location, set `LOCATION_PING_TOKEN` on the portal as in [Location ping](../../docs/operations/location-ping.md), paste the same value in the app, tap Save token, switch on "Report place changes" and allow Always location. The token is bound to the address it was saved for and is sent only there, over https. Saving a different address clears the token and turns reporting off.

App Transport Security is at its default (https only, no exceptions).

## Limits, not yet verified on a phone

- A failed location POST is dropped with no retry, and readings closer than 30 seconds are skipped.
- Location reporting after a background relaunch.
- Whether a re-sign resets the app bundle's creation date; the reminder falls back to the first-launch date.
- Free signing cannot grant Time Sensitive notifications, so the reminder is an ordinary alert.
