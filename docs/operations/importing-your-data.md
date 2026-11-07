# Importing your data

You need this when you want to load a data export (Google Takeout, Spotify, Discord, Apple Health) into the [activity store](../architecture/activity-store.md) so a later predictor can read your history from one place.

`rhen import <source> <path>` reads the export on your own computer, parses it there, and sends only the parsed events to the portal, in batches. The file itself is never uploaded, so a multi-gigabyte Takeout or Apple Health export is fine. Nothing is unzipped to disk. The same event is never stored twice: importing a newer export of the same account adds only what is new.

## Before the first import

1. **Make a token that can only write activity.** In PowerShell:

   ```powershell
   rhen agent-token create --name importer --scopes activity-capture
   ```

   Keep the token it prints. The preset grants `write:activity-event` and nothing else.

2. **Point the CLI at the portal.** Raise the request timeout, because a batch of 1000 events can take a few seconds:

   ```powershell
   $env:OPENRHEN_URL = "http://homeserver:8787"
   $env:OPENRHEN_TOKEN = "<the token>"
   $env:OPENRHEN_TIMEOUT_MS = "60000"
   ```

3. **Decide about text.** Titles, search text, page addresses, track names and message text are stored only for a source whose content gate is on. It is off by default, and text sent while it is off is dropped (the import prints how many events lost their text). Turn it on, as the owner, before importing the sources you want kept in full:

   ```powershell
   Invoke-RestMethod -Method Put -Uri "$env:OPENRHEN_URL/api/activity-sources/spotify" -ContentType "application/json" -Body '{"contentEnabled": true}'
   ```

   This route is owner-only, so a portal that runs with `OPENRHEN_OWNER_AUTH=require` needs the owner credential on the request (see "Owner token" in the [CLI README](../../tools/cli/README.md)); there is no settings screen for it yet. Use `chrome-takeout`, `google-activity`, `maps-places`, `fit`, `spotify`, `discord-package` or `apple-health` in place of `spotify`. The gate decides what is stored from then on; turning it on after an import does not bring the dropped text back, so set it first.

4. **Put the exports in one folder**, for example `C:\Users\you\Documents\data-exports\`, and quote any path with a space.

Try any import first with `--dry-run`: it parses the file and prints what would be sent, with no request to the portal.

## What to request, and in which format

### Google Takeout (Chrome, My Activity, Maps, Fit, YouTube)

Go to takeout.google.com, choose **Deselect all**, then tick only:

| Product | Choose | Format | Becomes |
|---|---|---|---|
| Chrome | all data | JSON (Chrome history is always JSON) | `chrome-takeout` visits |
| My Activity | all products except YouTube (Search, Maps, Assistant, Gemini Apps, Discover) | **JSON**, not HTML | `google-activity` searches, views and prompts |
| Maps (your places) | saved places | JSON | `maps-places` |
| Fit | daily activity metrics | CSV | `fit` steps (best effort) |
| YouTube and YouTube Music | history | **JSON**, not HTML | the existing watch-history route |

Pick **Export once**, `.zip`, and the largest part size offered. A large export arrives as several parts; download them all into one folder and point the command at the folder. Google builds the export in hours to a day or two and emails a link that expires after a week.

```powershell
rhen import takeout "C:\Users\you\Documents\data-exports\takeout"
rhen import takeout "C:\Users\you\Documents\data-exports\takeout-20260105T010203Z-001.zip"
```

`takeout` finds each product by the name of its file, so it works whatever language the export folders are in, and it tells you which products it did not find. To load one product from a single file:

```powershell
rhen import chrome "C:\path\to\BrowserHistory.json"
rhen import google-activity "C:\path\to\Search\MyActivity.json"   # the product is the folder name
rhen import maps "C:\path\to\Saved Places.json"
rhen import fit "C:\path\to\2026-01-02.csv"
rhen import youtube "C:\path\to\watch-history.json"
```

Notes on what Takeout gives and what this reads:

- **YouTube** is not parsed by the importers. The CLI takes only the `history/watch-history.json` entry out of the zip and sends it to the YouTube history import that Review already uses, which holds a file of at most 50 MB. A larger history needs a shorter date range from Takeout. My Activity folders for YouTube and YouTube Music are skipped so nothing is counted twice.
- **My Activity** titles are read by their verb: "Searched for", "Visited", "Viewed", "Prompted" and "Said". A title with any other verb is skipped and counted, with the reason, rather than guessed at; the summary names the commonest skipped verbs ("Used", for example) so you can see what was left out.
- **Maps**: a saved place becomes an instant event at the date it was saved. A place with no date (labelled places such as Home and Work carry none in the file) has no time to put it at, so it is skipped and counted.
- **Fit** is being retired by Google and its export has changed shape before, so it is best effort. Interval files (`Daily activity metrics/2026-01-02.csv`) become step events with their time zone. A per-day summary file becomes one approximate event per day, because a bare date has no time zone.
- **Chrome** times are read as microseconds since 1970, and a value outside 1995 to tomorrow is skipped, because guessing a different epoch would move every visit.
- Location history (Timeline) is not read.

### Spotify

In the Spotify account page choose **Privacy settings**, then **Download your data**, and tick **Extended streaming history** (not the basic account data, which holds about a year). It takes up to 30 days. The zip holds `Streaming_History_Audio_*.json`.

```powershell
rhen import spotify "C:\Users\you\Documents\data-exports\my_spotify_data.zip"
```

The export's time is when a play **ended**; the importer starts it `ms_played` earlier. Only your own play facts are kept: the track or episode id, the times, whether it was skipped, and the names (as text). Country, IP address and device strings are never read. Audiobooks and removed items have no id and are skipped and counted.

### Discord

In Discord open **User Settings**, then **Privacy and safety**, then **Request all of my data**. Ticking only **Messages** is enough. Discord emails a link, and the zip holds `messages/c<channel id>/messages.csv` (older packages: `messages.json`).

```powershell
rhen import discord "C:\Users\you\Documents\data-exports\package.zip"
```

The package holds only the messages you sent, so every row becomes a message from you, with the channel id as `thread_id`. Message text is stored only while the `discord-package` content gate is on; attachment links are never kept, only whether there was one.

### Apple Health

On the iPhone open **Health**, tap your picture, then **Export All Health Data**. Send the `export.zip` to the PC (the export can be several GB; AirDrop or a cable is easier than email).

```powershell
rhen import apple-health "C:\Users\you\Documents\data-exports\export.zip"
```

The importer streams `apple_health_export/export.xml` without loading it. It stores **hourly step counts** (one row per hour per source device), **sleep** (one row per stage) and **workouts**. Heart rate and every other record type are ignored. An iPhone and an Apple Watch each keep their own rows; the two are not merged, so add nothing up across devices without choosing one. Each row records the offset it was written with, so the local hour is not lost.

## What the command prints

For each source it reads, one block:

```text
spotify (my_spotify_data.zip): read 41210 rows; sent 41198: added 41198, already held 0, rejected 0; skipped 12 unreadable, ignored 0.
  skipped 12: no Spotify track or episode id (an audiobook or a removed item)
```

- **read** are rows of the kinds that source handles; **skipped** are rows that were malformed or unrecognised (each reason is listed); **ignored** are valid rows that are not wanted, such as heart-rate records.
- **added** and **already held** come from the portal; held rows are never changed.
- **rejected** are events the portal refused. Each reason is spelled out with the event number it first happened at, for example a time more than 24 hours in the future. One bad event rejects itself, not the batch.
- **content dropped** appears when a source's content gate is off.
- A file that ends in the middle of a record is reported as cut off; what was read before the break is still imported, and downloading the export again fixes it.

Add `--json` for the same information as data. The import id each block ends with is what the owner uses to undo that import (`DELETE /api/activity-imports/<id>` in the portal, or the activity summary).

## Running an import again

The command asks the portal whether the file is already held, by its SHA-256. If it is, the command says so, gives the number of events held, and sends nothing. An import that stopped half way (a network error) is also "held", so a held file is not proof that it finished: to resume it, run the same command with `--yes`. Sending again is safe: events already stored are skipped and the rest are added. A zip or folder that feeds several sources is recorded once per source, under a hash of the file and the source name, so Chrome, My Activity and the others from one Takeout are separate imports and can be undone separately.

`rhen import` also keeps its older actions (`list`, `preview`, `commit` and the rest) for reviewed planning-data batches. A source name is how the CLI tells the two apart. Importing a data export runs only from the command line; it is not available over MCP, because it reads a file on your computer.

## Known limits

- **Place names and device names bypass the content gate, by design.** A Maps place name (`maps-places`) and an Apple Health `sourceName` (`apple-health`, for example "Jo's iPhone") are stored in `attrs`, not `content`, so they are kept even when the source's content gate is off. Everything else that is text (titles, search text, page addresses, track names, message text) is in `content` and obeys the gate.
- **Spotify duplicates from the live poller.** The export and the later live poller (a separate change) can round a play's end time differently, so a play seen by both may be stored twice until the poller change adds a proximity rule (same track, end within 3 seconds). Importing only the export is not affected.
- **Apple Health's newest hour of steps is held back.** For each device the last hourly bucket in the file may be partial (an export taken mid-hour), and a stored bucket is never changed, so it is left out and counted as ignored. The next export that reaches past it adds it. A device that never records again keeps its final hour out.
- **A damaged zip entry is found at its end.** A zip entry's checksum is verified as the last bytes are read, so events from an entry that turns out damaged may already have been sent. The command stops with the error and prints the import id; the owner can undo that import by id, or run the command again with `--yes` once the export is downloaded again.
- **Duplicate paths across zip parts** are reported in a note; only the first copy is read.
- A single event whose JSON is over 1 MB is not sent and is counted as skipped, and a CSV record with a field over 1 MB is skipped and counted.
