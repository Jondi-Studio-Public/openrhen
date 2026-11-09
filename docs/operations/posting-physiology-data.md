# Posting physiology data

You need this when you build your own collector that sends wearable, phone or health-app data (heart rate, sleep, steps and so on) to the activity store.

OpenRhen defines what the data looks like and where it is posted. It has no poller, adapter or provider key: you write the collector, in whatever language and against whatever device or service you use, and post to `POST /api/activity-events`. Physiology rows are context for a predictor. They never change what the plan allows, and the planning engine cannot read them.

The shape is published as `platform/contracts/physiology-schema.v1.json`. The rules that schema cannot express (the key, period boundaries, sample counts) are checked by the server, and each rejection names the field and the fix. The store itself is described in [Activity store](../architecture/activity-store.md).

## 1. Make a token and post

In the portal go to **Settings, Agent tokens**, create a token for your collector, and choose the **activity-capture** preset. Post with the `X-OpenRhen-Token` header. The preset can write events and read nothing back. Send the same device label in `attrs.device` and in the batch's `device`:

```text
POST /api/activity-events
X-OpenRhen-Token: <token>
Content-Type: application/json

{"schema": 1, "device": "band-1", "events": [
  {"id": "steps|band-1|2026-11-08T10:00:00.000Z|v0", "source": "physiology", "kind": "steps",
   "start": "2026-11-08T10:00:00Z", "attrs": {"device": "band-1", "route": "phone-app", "v": 0, "steps": 420}}
]}
```

## 2. Shapes: map your data onto the kinds

Every physiology event has `source: "physiology"` and is a period row: it covers one period and is identified by that period, never by when you fetched it.

| Kind | Period | Body attrs beyond the common ones |
|---|---|---|
| `heart_rate` | UTC hour | samples, `unit: "bpm"`, `step_s` of 15 or more, or null |
| `heart_rate_dense` | 5-minute UTC slot | samples, `unit: "bpm"`, `step_s` 1 to 14 |
| `hrv` | UTC hour | samples, `unit: "ms"`, `method`: `rmssd` or `sdnn` (never mixed) |
| `stress` | UTC hour | samples, `scale` |
| `score_series` | UTC hour | samples, `score_name`, `scale` (any named score sampled through the day) |
| `respiration`, `spo2`, `skin_temp` | UTC hour | samples; `unit` is `br/min`, `%`, and `degC` or `degC_delta` |
| `steps` | UTC hour | `steps` (whole number) |
| `movement` | UTC hour | `basis`: `device_label` or `inferred` (`inferred` needs `approximate: true` on the event); `segments` of `{start_s, end_s, state}`, `state` one of `sedentary`, `active`, `walking`, `running`, `cycling`, `other`, `unknown` |
| `sleep` | the night | `local_date` of waking; `segments` of `{start_s, end_s, stage, stage_raw?}`, `stage` one of `in_bed`, `asleep`, `awake`, `light`, `deep`, `rem`; optional `scores`. Needs `end` (the time you woke), at most 24 hours after `start` |
| `daily` | `local_date` | at least one of `steps`, `resting_hr`, `stress_avg`, `active_min`, `kcal_active`, `floors`, `distance_m`, `scores` |
| `score` | `score_name` and its period start | `score_name`, `scale`, `value` (inside the scale); optional `local_date` for a daily score |
| `workout` | the workout | `activity_type`; optional `ext_id`, `duration_min`, `distance_m`, `energy_kcal`, `avg_hr`, `max_hr` |

**Common attrs, on every row:** `device` (your stable label for the physical device, 1 to 64 characters from `A-Z a-z 0-9 . _ : -`, so no `|` and no spaces), `route` (how this row was obtained, such as `phone-app` or `file-export`; 1 to 32 characters, same characters), `v` (the version, a whole number 0 to 999) and optionally `collector_version` (text, at most 32 characters). Any other attr is rejected with the allowed list.

**Samples** (the sampled kinds): `values` is a list with `null` for a gap, on a grid of `step_s` seconds (so an hour at 15 s holds exactly 240 values), or `step_s: null` with `t`, the second offsets of irregular readings (sorted, inside the period, at most 240). Also `n` (the count of non-null values), `min`, `max`, `avg` (`min <= avg <= max`), `coverage_s` (the seconds the readings cover, at most `n x step_s`, or at most the period when irregular), and optionally `src_step_s` (the source's own step), `flags` (one code per value, for a reading the device could not measure; that value must be `null`) and `tz_change` (`{at_s, tz_offset_min}`). Values have at most one decimal place, and are whole numbers for `bpm`. A row holds at most 300 values. Never post an empty period.

**A scale** is `{min, max, higher_means}`, where `higher_means` is free text such as `"more stress"`. A vendor's own stage or score names are data: put the original stage in `stage_raw`, map `stage` to the neutral list, and put a score's name in `score_name`. A converted unit keeps its original in `unit_raw`. Send dense data (readings every 1 to 14 seconds) as `heart_rate_dense`, plus a downsampled hourly `heart_rate`.

**Time.** UTC on the wire. Send `tzOffsetMin`, or an offset in `start` such as `+11:00`; leave it out when you do not know it, and do not guess. Units are bpm, m, kcal, s, kg and degC. `approximate: true` marks values you inferred rather than measured. Segment offsets are seconds from the period start, sorted and not overlapping. Never sum steps or energy across devices.

## 3. Keys and versions

The event `id` must be the canonical key:

```text
<kind>|<attrs.device>|<period>|v<attrs.v>
```

| Kind | `<period>` |
|---|---|
| Hourly and 5-minute kinds | the UTC slot start, RFC 3339 with milliseconds and `Z`, such as `2026-11-08T10:00:00.000Z` |
| `sleep`, `daily` | `attrs.local_date`, `YYYY-MM-DD`, exactly as the source states it |
| `score` | `<score_name>@<attrs.local_date, or the start as above>` |
| `workout` | `x:<attrs.ext_id>` when the source gives a stable id, otherwise the start to the second, such as `2026-11-08T10:00:00Z` |

`route` is not in the key, so the same fact from two routes or two collectors lands on the same key. The server computes the key from your attrs and `start` and rejects any other, stating the one it expected. A single-event shorthand post gets a server-made `h:` key when you send no `id`; for physiology that is rejected too, so send the canonical `id` in the shorthand.

The store keeps the first write of a key and ignores later ones. To add or correct data for a period you already posted, post it again with `v` one higher than the highest you hold. Bump `v` only when coverage or values actually change, so a collector cannot loop. Each event answered `alreadyHeld` comes back in the response's `held` list as `{index, key, v, coverage_s, n}`, taken from the stored row. A collector that lost its state compares that with what it has and re-posts with the next `v` if it has more. Nothing is swallowed silently.

For a deletion at the source, post a `correction` with `attrs: {corrects: <key>, void: true}`; for a bug in your own earlier output, `attrs: {corrects: <key>, fix: {<corrected attrs>}}`. Its key is `correction|<corrected key>|<n>`, with `n` a whole number from 0 to 999. A correction is not a way to add data: use the next `v` for that.

## 4. When to post, and batching

Post a period once it has ended and you have seen a later sample from the same device, which shows a sync passed it. Hold not-yet-final data in your collector. Posting early is safe but costly: every later improvement adds a row. A worst-case row is about 3.5 KB of JSON and the attrs limit is 8 KB.

Batch by bytes, at most 1.5 MB per request (the request cap is 2 MB, and an oversize body gets a 413 with nothing stored). That is about 400 worst-case rows, or about 1,000 integer-only hourly blocks. Keep your own cursor and retry queue: OpenRhen keeps no collector state.

Lessons that apply to any collector:

- Window your fetches so a sync gap of several days is read again.
- Finalise a period on a later sample from the same device, so sparse metrics do not wait for their own next sample.
- Never post empty periods.
- Cap the size of upstream responses you read.
- Treat an entry in `rejected` as a bug to fix, never as something to retry. The reason names the field.

What no feed can do: give live data from a vendor cloud (the device-to-phone-to-cloud sync is the floor), read a locked phone's health store, or tell "not worn" from "not synced". OpenRhen reports only "no data newer than X".

## 5. Check before you post, and read back

Validate against `platform/contracts/physiology-schema.v1.json` before posting. To read rows back, `GET /api/activity-events?source=physiology&kind=heart_rate` needs a token with both `read:activity-event` and `read:activity-health` (`rhen agent-token create --name reader --scopes read:activity-event,read:activity-health`). Without the second scope the page comes back with the health sources left out and `withheld` naming them. The owner session reads everything.

When two rows describe one period of one device and kind, a reader prefers, for sampled kinds, the larger `coverage_s`, then the higher `v`, then the later ingest time; for the other kinds, the higher `v`, then the later ingest time. Two workouts on one device that overlap by more than half are one workout, and the higher `v` wins.

The older health sources stay as they are. `apple-health` sleep intervals are the same facts as `sleep` segments, `apple-health` workout and steps correspond to the kinds of the same names, and `iphone-health` `*_day` rows correspond to `daily` fields. A reader reads them alongside `physiology`.
