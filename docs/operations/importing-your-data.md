# Importing your data

You need this when you want to load a data export (Google Takeout, Spotify, Discord, Apple Health, standard mail files) into the [activity store](../architecture/activity-store.md) so a later predictor can read your history from one place.

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

   This route is owner-only, so a portal that runs with `OPENRHEN_OWNER_AUTH=require` needs the owner credential on the request (see "Owner token" in the [CLI README](../../tools/cli/README.md)); there is no settings screen for it yet. Use `chrome-takeout`, `google-activity`, `maps-places`, `fit`, `timeline`, `google-chat`, `google-access-log`, `google-photos`, `spotify`, `discord-package` or `apple-health` in place of `spotify`. The gate decides what is stored from then on; turning it on after an import does not bring the dropped text back, so set it first.

4. **Put the exports in one folder**, for example `C:\Users\you\Documents\data-exports\`, and quote any path with a space.

Try any import first with `--dry-run`: it parses the file and prints what would be sent, with no request to the portal.

## What to request, and in which format

### Google Takeout (Chrome, My Activity, Maps, Fit, Timeline, Chat, Access Log, Photos, YouTube)

Go to takeout.google.com, choose **Deselect all**, then tick only:

| Product | Choose | Format | Becomes |
|---|---|---|---|
| Chrome | all data | JSON (Chrome history is always JSON) | `chrome-takeout` visits |
| My Activity | all products except YouTube (Search, Maps, Assistant, Gemini Apps, Discover) | **JSON**, not HTML | `google-activity` searches, views and prompts |
| Maps (your places) | saved places | JSON | `maps-places` |
| Fit | daily activity metrics | CSV | `fit` steps (best effort) |
| Timeline (Location History) | all data | JSON | `timeline` place visits, activity segments and location points (**unverified**) |
| Google Chat | all data | JSON | `google-chat` messages (**unverified**) |
| Access Log Activity | all data | CSV or JSON | `google-access-log` accesses (**unverified**) |
| Google Photos | all albums | JSON sidecars come with the photos | `google-photos` photo and video metadata (**unverified**) |
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

### Downloading a large Takeout without clicking every part

Google gives no download API, so `scripts/ops/takeout-download.ps1` replays one download request your browser already made, once per part. Copy a part's download as "cURL (bash)" from the browser's Network tab into a private text file, then:

```powershell
.\scripts\ops\takeout-download.ps1 -RequestFile C:\Users\you\Documents\data-exports\request.txt -OutDir C:\Users\you\Documents\data-exports\takeout -From 0 -To 35
```

Keep the request file outside the repository (the script refuses one inside a git working tree) and delete it afterwards: it holds your login cookies, which the script hands to curl through a private temporary file, never the command line. A full export has dozens of parts and the cookies last about an hour, so expect to copy a fresh request over the same file part-way through and run the same command again. A half-downloaded part resumes from the byte it reached, finished parts are skipped, and the script checks free disk space (`-MinFreeGB`, default 120) and each part's size. `download-log.txt` in the folder maps each part number to its file name. The script's header has the full steps.

Notes on what Takeout gives and what this reads:

- **YouTube** is not parsed by the importers. The CLI takes only the `history/watch-history.json` entry out of the zip and sends it to the YouTube history import that Review already uses, which holds a file of at most 50 MB. A larger history is split into several parts under that limit and sent one after another; each part is its own import, and the command lists every import id. Run it again after a failure: watches already held are never duplicated. My Activity folders for YouTube and YouTube Music are skipped so nothing is counted twice.
- **My Activity** titles are read by their verb: "Searched for", "Visited", "Viewed", "Prompted" and "Said". A title with any other verb is skipped and counted, with the reason, rather than guessed at; the summary names the commonest skipped verbs ("Used", for example) so you can see what was left out.
- **Maps**: a saved place becomes an instant event at the date it was saved. A place with no date (labelled places such as Home and Work carry none in the file) has no time to put it at, so it is skipped and counted.
- **Fit** is being retired by Google and its export has changed shape before, so it is best effort. Interval files (`Daily activity metrics/2026-01-02.csv`) become step events with their time zone. A per-day summary file becomes one approximate event per day, because a bare date has no time zone.
- **Chrome** times are read as microseconds since 1970, and a value outside 1995 to tomorrow is skipped, because guessing a different epoch would move every visit.
- **Unverified formats.** The Timeline, Google Chat, Access Log Activity and Google Photos parsers were written from the documented and community-known shapes of those exports, with synthetic test fixtures, and have not been run against a real export. Run `--dry-run` first and read the skipped reasons: a format that has drifted is skipped and counted, never guessed. Report a real file that does not parse. Each run of these four prints a note that the format is unchecked. A file whose wrapper is not recognised (no list of rows where the format puts one), or an Access Log whose header has no timestamp or no product or activity column, stops with an error that names the top-level keys or columns found and what was expected; a run that gives no events, or skips most rows, prints a `WARNING` with the commonest skipped reason and what to report (the source name, the file name and the reasons, never the file's contents).
- **Timeline** reads `Records.json` (raw points, one `point` event each: a long history is millions of rows), `Semantic Location History/<year>/<year>_<MONTH>.json` (`place_visit` with start and end, `activity_segment` with both ends) and the on-device `Timeline.json` (a list, or `semanticSegments`; path points become `point`), including the iPhone Maps export, which writes positions as `geo:lat,lng` text, the place id as `placeID` and probabilities as strings (checked only against a synthetic sample so far). Times need a zone or are epoch milliseconds; a number of another size is skipped, not rescaled. Place name and address are text (`content`); positions are in `attrs` (rounded to about a metre), so, like Maps places, they are kept whatever the content gate says. The raw `Records.json` points file is the biggest source in a Takeout; import it on its own with `rhen import timeline <Records.json>` if you do not want it in a `takeout` run.
- **Google Chat** reads `Groups/<space>/messages.json`; the space id is `thread_id` and each message (yours and others') is a `message` with the sender's address as `from`. Only the text is kept (as content); annotations and attachment names are not. Who you are comes from `Users/<id>/user_info.json`; without it `from_self` and `direction` are left out. `created_date` is English text such as "Monday, January 2, 2023 at 3:04:05 PM UTC"; a message in another wording or zone is skipped and counted, because reading it would mean guessing. `group_info.json` is not read.
- **Access Log Activity** reads the "Activities" file only (the "Devices" file is not read). Each row becomes an `access` with the product and activity type. The IP address and user-agent columns are never read, so they cannot reach the store.
- **Google Photos** reads only the small `.json` sidecar beside each photo or video (`IMG_1234.jpg.json`, or `.supplemental-metadata.json`). The photo and video files are never opened or sent, and album `metadata.json` is ignored. One event per item (`photo` or `video`) at `photoTakenTime`, with its position in `attrs`, and file name and description as content. An item with no `photoTakenTime` is skipped (the upload time is not when it happened). One caution: when the export is a single zip, the recorded checksum is the zip's SHA-256, which reads the whole zip on this computer to hash it; nothing in it is parsed or sent except the sidecars. An unzipped folder hashes only the sidecars.
- **Flow** (Google's Takeout "Flow" product) is not read: its file format is not documented anywhere in this repository and cannot be built without a real export. Send a sample (with private content removed) and it can be added.

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

### Mail files (`.mbox`, `.eml`)

```powershell
rhen import mail "C:\Users\you\Documents\mail\archive.mbox" --source my-mail-import --dry-run
rhen import mail "C:\Users\you\Documents\mail" --source my-mail-import
```

This reads standard mail files: mbox (mboxrd and mboxo: `From ` separator lines, `>From ` unescaped) and single `.eml` messages (RFC 5322 and MIME). The path may be one file, a folder or a zip; every `.mbox`, `.mbx` and `.eml` inside is read, in path order, as one import. It is built from the standards and tested on synthetic files only; no real mailbox export has been used to check it, so read the warnings it prints.

- **You name the source** with `--source`. It must be a `message@1` source an extension has registered ([Posting messages](posting-messages.md) section 1); core registers none. The command refuses a core source that is not `message@1` (the legacy mail source would double-count mail a live collector already posts), and for a name it cannot check it prints a warning, because only the portal knows what an extension registered. Use a source of its own for files. Each message is posted as a `message@1` event with the file's text kept (an import is your consent, whatever the source's content gate says). Running it again posts the same keys, so held messages are `already held`.
- **Keys, three cases:** `mid:<Message-ID>` when the id has the RFC shape; otherwise, for a message with text, the `fp:` key (sender, minute and text); otherwise, for a message with an odd id and no text, `mid:<that id>` with a counted warning. That last key is unique only inside the source, so two different no-text messages that share the same non-RFC id are one key and the second is `already held`.
- **Text:** `text/plain` is preferred, otherwise `text/html` is reduced to text. Quoted-printable and base64 are decoded and RFC 2047 headers read in their charsets. Attachments are counted (`attachments ignored`) and never read. Text over 64 KB is cut and counted as a warning.
- **Attrs:** sender (the address), `to` (To and Cc, at most 20), subject, `thread_id` (the first id in `References`, else `In-Reply-To`, else the message's own id), `channel` (the file name without its extension) and, with `--self a@x,b@y`, `from_self` and `direction`. The sent time is the `Date` header. A missing, unparseable or absurd (before 1990 or in the future) `Date` is counted as a warning and replaced by the `From ` line's date or the oldest `Received` date, marked approximate; with none of them the message is skipped and counted. A zone name the importer does not know (or no zone) is read as UTC with a counted warning. In HTML, a tag is taken to hold a stray quote when it has a `<` outside a quote, runs past 256 KB, never closes, or closes only after a quoted value that holds markup (a closing tag, or an opening tag with an attribute): it is closed at its first `>` and the recovery is counted as one warning (one per tag). This is a heuristic with two known limits. A stray attribute quote followed by a text quote and a raw `>` can still drop text with no warning (for example `<p class="a>Hello<br>there 5" ></p>` loses "Hello there 5"). Markup inside a quoted value (for example `alt="<img src=x>"`) warns and leaks the closing quote and bracket into the text, with no words lost. Odd but legal attributes (`title="a<b"`, `title="x<y>z"`, `title="a<b c"`, a style wrapped over lines, a long inline image) are read normally with no warning. HTML that ends inside a tag or comment (an unterminated tag) drops the rest of that message's text; that is counted too.
- **One message in several files** is posted once: the first copy of a `Message-ID` wins and the rest are counted (`duplicate Message-ID in this import`).
- **It stops on anything it does not recognise**, with the file, the message number and the byte where the message starts: a file that is not mbox, garbage where a header should be, a multipart with no closing boundary, an unknown transfer encoding or charset, a text part holding NUL bytes, an empty file, or a message over the per-message cap (128 MiB; `--max-message-mib <n>` raises it to at most 512). Nothing is truncated or skipped silently. This strict mode is the default. Events sent before the stop stay under the import's id, and running the command again after the fix is safe.
- **`--skip-unreadable`** changes only the per-message failures above (bad charset or transfer encoding, unclosed multipart, damaged headers, over the cap): that message is skipped, counted under "unreadable message skipped", and named in the summary with its file, message number, byte offset and reason (the first 100; the rest are counted). The run is then `needs_review`. Byte offsets of messages after an over-cap message that was dropped can be under-reported (the bytes of a very long unterminated line are not all counted), so use the message number first. A file that is not mbox, or is empty, still stops the import. Use it after a strict run shows a few bad messages in a very large file.
- **Memory:** the file is streamed and one message is held at a time; the only state that grows with the file is a short digest per `Message-ID` for the duplicate check.

## What the command prints

For each source it reads, one block:

```text
spotify (my_spotify_data.zip): read 41210 rows; sent 41198: added 41198, already held 0, rejected 0; skipped 12 unreadable, ignored 0.
  skipped 12: no Spotify track or episode id (an audiobook or a removed item)
```

- **read** are rows of the kinds that source handles; **skipped** are rows that were malformed or unrecognised (each reason is listed); **ignored** are valid rows that are not wanted, such as heart-rate records.
- **added** and **already held** come from the portal; held rows are never changed.
- **rejected** are events the portal refused. Each reason is spelled out with the event number it first happened at, for example a time more than 24 hours in the future. One bad event rejects itself, not the batch.
- **warning** lines count fallbacks taken for rows that were still sent (mail: a missing `Date`, a `Message-ID` that is not RFC-shaped); a run with any is `needs_review`. Plain tallies such as `attachments ignored` follow them.
- **content dropped** appears when a source's content gate is off.
- A file that ends in the middle of a record is reported as cut off; what was read before the break is still imported, and downloading the export again fixes it.

Each source also reports one run to the portal when it finishes (`POST /api/activity-imports/runs`: `synced`, `needs_review` when rows were skipped, rejected or warned about, or `failed`), so an import that brought in nothing is on record. If the portal cannot take the report, the command prints one warning and the import is unaffected. When one source fails (a damaged file, a refused batch), the others still run and print their blocks, and the command exits non-zero at the end.

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
