# Location ping

You need this when you want a phone automation to tell OpenRhen where you are.

`POST /api/location/ping` is the channel for a phone automation that reports your location when you arrive or leave somewhere. It is optional.

The portal never trusts one reading alone. A ping either refreshes the staleness clock of the place you are already recorded at (the reading agrees), leaves a suggestion for Now to raise, or, after a sustained stay at a different saved place, updates your location. Readings coarser than 500 m never refresh or sustain a place, and two agreeing fixes more than an hour apart are not one stay.

The route keeps its own bearer token, separate from owner sign-in, so a phone automation needs no owner credential. A phone that was added with **Add a phone** (see [Locking down the API](locking-down.md#adding-a-phone)) can instead send its own owner token in `X-OpenRhen-Owner`: the route checks that token itself under every `OPENRHEN_OWNER_AUTH` mode, a revoked token gets the owner-auth error (`401`, "The owner credential was revoked") rather than "requires a valid location token", and a cookie is never accepted, so a browser cannot move your location. The token names the phone, and the body may carry an optional `device` (the phone's install id; if both are given they must match). Sustained presence is read per phone, so two phones cannot break each other's ten minutes. `LOCATION_PING_TOKEN` keeps working for third-party collectors, with or without `device`.

## 1. Set the token

Put a long random value in `.env`:

```text
LOCATION_PING_TOKEN=<a long random string>
```

With it unset or empty the route refuses every request. Restart the portal afterwards.

## 2. iOS Shortcuts

Shortcuts > **Automation** > **+** > **Create Personal Automation** > **Location**. Choose a region and **When I Leave** (or **Enter**), and turn off **Ask Before Running**. Add two actions: **Get Current Location**, then **Get Contents of URL** with:

- URL `https://<your portal host>/api/location/ping`, method `POST`
- Headers `Authorization: Bearer <the token>` and `Content-Type: application/json`
- A JSON body of four fields, each set from the magic variable of the same meaning:

```json
{
  "latitude": "Latitude of Current Location",
  "longitude": "Longitude of Current Location",
  "accuracyMeters": "Horizontal Accuracy of Current Location",
  "observedAt": "Current Date (ISO 8601)"
}
```

Picking the wrong variable type is the most common way this silently sends nothing useful.

## 3. Android with Tasker

Create a **Location** profile (entry or exit) and a task with an **HTTP Request** action: method `POST`, the same URL and headers, and a body with the same four fields built from Tasker's location variables and an ISO 8601 timestamp.

## 4. Confirm it worked

Open Now, or run `rhen status --json`, and check the current location. A ping that only refreshed the clock changes nothing visible except the assertion time moving forward.

- **401**: the `Authorization` header does not match `LOCATION_PING_TOKEN` exactly.
- **400**: the body failed validation. Check all four fields, and that `observedAt` is a full ISO 8601 timestamp with a timezone offset. A timestamp too far from the server's clock is also refused, so a phone with a wrong clock cannot refresh a place.
