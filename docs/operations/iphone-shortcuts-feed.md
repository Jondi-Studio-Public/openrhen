# iPhone Shortcuts feed

You need this when you want your iPhone to record what it does (apps opened, Focus changes, charging, places, and a daily Apple Health summary) into the activity store.

Each event is one `POST /api/activity-events` call made by an iOS Shortcuts personal automation. The phone needs no app. The portal must be reachable from the phone (on the home network, or over Tailscale to the same https name). This is separate from the [location ping](location-ping.md), which stays as it is.

Apple Health exports and one-off history are imported with the importers instead; this feed is the live part.

## What gets sent

Two sources, both validated by the activity store's registry:

| Source | Kinds | Sent when |
|---|---|---|
| `iphone-shortcuts` | `app_open`, `app_close`, `focus_on`, `focus_off`, `charger_on`, `charger_off`, `place_arrive`, `place_leave`, `wifi`, `wake`, `alarm` | the automation fires |
| `iphone-health` | `steps_day`, `sleep`, `workout`, `heart_rate_day`, `energy_day` | once a day |

Anything you add to the Dictionary the automation hands to the shared shortcut (below) arrives as `attrs`, so `name`, `battery`, `place` and so on need no server change. App and place names go in `attrs`, which is always stored. The source's content setting in portal Settings gates only the separate `content` field, which these recipes do not use.

## 1. Make the token

In the portal go to **Settings → Agent tokens**, create a token named `iphone`, and choose the **activity-capture** preset. Copy it once; it is shown once. Do not put it in an env file or a repository.

On the phone, store it as a text in a Shortcuts action (step 2). Anyone who can edit your shortcuts can read it.

## 2. The shared shortcut "Rhen Event"

Every automation below hands this one shortcut a Dictionary. Build it once.

Shortcuts app → **Shortcuts** tab → **+** → name it `Rhen Event`. Under its settings turn **Show in Share Sheet** off. Add, in order:

1. **Get Dictionary from** *Shortcut Input*.
2. **Get Dictionary Value** for key `kind` from *Dictionary*. (This variable is **Kind**.)
3. **Current Date**.
4. **Format Date**: *Current Date*, format **ISO 8601**. (**Now**.)
5. **Get Contents of URL**:
   - URL: `https://<your portal host>/api/activity-events`
   - Method: **POST**
   - Headers: `X-OpenRhen-Token` = your token; `Content-Type` = `application/json`
   - Request Body: **JSON**, with these fields:
     - `source` (Text): `iphone-shortcuts`
     - `kind` (Text): the **Kind** variable
     - `start` (Text): the **Now** variable
     - `device` (Text): `iphone`
     - `attrs` (Dictionary): the *Dictionary* variable from step 1

The server fills in the event id, so a retry of the same second is not double-counted.

## 3. Test it

Run `Rhen Event` once by hand from a tiny test shortcut: **Dictionary** with `kind` = `app_open` and `name` = `Test`, then **Run Shortcut** `Rhen Event` with that Dictionary as input. Then, in a browser tab signed in to the portal, open `https://<your portal host>/api/activity-events/summary`. It lists a last event for `iphone-shortcuts`. (The route is owner-only, so a token cannot read it; your signed-in session can.) If **Get Contents of URL** shows an error body, it names the exact field to fix.

## 4. The automations

Shortcuts → **Automation** → **+** → **Create Personal Automation**. For every one: choose **Run Immediately** (not Ask Before Running), turn **Notify When Run** off, then add a **Dictionary** action followed by **Run Shortcut** `Rhen Event` with that Dictionary as input. Only the trigger and the Dictionary change.

**App opened or closed.** Trigger **App**, pick one app, choose **Is Opened** (second automation for **Is Closed**). Dictionary: `kind` = `app_open` (or `app_close`), `name` = the app's name. iOS does not tell a shortcut which app fired it, so you need one automation per app. Start with the few that matter: messaging, browser, video, games, work.

**Focus.** Trigger **Focus**, pick the Focus, **When Turning On** → `kind` = `focus_on`, `name` = the Focus name; a second one **When Turning Off** → `focus_off`.

**Charger.** Trigger **Charger**, **Is Connected** → `kind` = `charger_on`; **Is Disconnected** → `charger_off`. Add a **Get Battery Level** action first and put it in the Dictionary as `battery`.

**Places.** Trigger **Arrive** or **Leave**, pick the place, `kind` = `place_arrive` or `place_leave`, `place` = the place's name. Add the places you care about (home, work, gym, shops).

**Wake and alarm.** Trigger **Sleep** → **Wake Up** gives `wake`; trigger **Alarm** → **Is Stopped** gives `alarm`.

**Wi-Fi.** Trigger **Wi-Fi** → pick a network → **Is Connected**, `kind` = `wifi`, `name` = the network. Useful as a cheap "where am I" signal.

## 5. The daily Apple Health push

Make a second shortcut `Rhen Health`, run by a personal automation. Trigger **Sleep → Wake Up** is the best choice: Health data is encrypted while the phone is locked, so a fixed-time automation can read nothing if the phone has not been unlocked, whereas the wake-up trigger fires when you pick the phone up.

In `Rhen Health`:

1. **Current Date** → **Adjust Date** (subtract 1 day) → **Get Start of Day**. Name it **Day**.
2. **Format Date** of **Day**, custom format `yyyy-MM-dd`. Name it **DayText**.
3. **Adjust Date** of **Day** (add 1 day). Name it **DayEnd**.
4. **Find Health Samples** where **Type** is **Steps** and **Start Date** is on or after **Day** and before **DayEnd**. Then **Calculate Statistics** → **Sum**. Name it **Steps**.
5. **Get Contents of URL** as in step 2 above, with these body fields:
   - `source`: `iphone-health`
   - `kind`: `steps_day`
   - `id`: `DayText:steps_day` (the variable, a colon, then the text)
   - `start`: **Day** formatted ISO 8601
   - `end`: **DayEnd** formatted ISO 8601
   - `device`: `iphone`
   - `attrs` (Dictionary): `total` = **Steps**
6. Repeat 4 and 5 for each other metric you want: **Sleep Analysis** (sum of asleep durations in hours, `kind` = `sleep`), **Workouts** (one event per workout, `kind` = `workout`, with its start, end and type, and `id` = `DayText:workout:` followed by the workout's start time, since several can happen in a day), **Heart Rate** (average and maximum, `heart_rate_day`), **Active Energy** (sum, `energy_day`).

Because `id` is the day plus the kind, running it twice for the same day is `alreadyHeld` and changes nothing. The first run asks permission to read each Health type; allow all of them.

## What does not work

- **Which app opened.** Shortcuts gives no app name, hence one automation per app. Time spent in an app is the gap between its open and close events; background switching is invisible.
- **Offline.** If the phone cannot reach the portal (Tailscale off, away from home with no tunnel), the event is lost. There is no queue on the phone. Keep Tailscale on with **Connect On Demand**.
- **Locked phone and Health.** See step 5. Check the next morning that yesterday's steps arrived.
- **Run banners.** iOS may still flash a banner for some triggers even with Notify When Run off. That is an iOS setting.
- **Any single event can be wrong or missing.** Treat the feed as a trail of signals, not a log of record.
