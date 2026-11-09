# Posting messages

You need this when you build your own collector that sends messages (a mailbox, a chat, a notification feed) to the activity store, so the plan can later learn what people asked of you.

OpenRhen defines what a message looks like and where it is posted. It has no poller, adapter or provider key: you write the collector, in whatever language and against whatever mailbox, chat or feed you use, and post to `POST /api/activity-events`. Message rows are context for a predictor. They never change what the plan allows, and the planning engine cannot read them.

The family is called `message@1`. The rules the server enforces are in `platform/contracts/src/activity-message.ts`, and each rejection names the field and the fix. The store is described in [Activity store](../architecture/activity-store.md).

## 1. Register a source and post

A message source is not built in. It is registered by an extension, under a name that starts with the extension's id, with the family `message@1`, the one kind `message`, and an `availability` block that says how the collector reaches the store (see [Writing a connection](../architecture/writing-a-connection.md)). Create a token for your collector with the **activity-capture** preset (Settings, Agent tokens) and post with the `X-OpenRhen-Token` header. The names below (`demo-inbox`, `demo-chat`) are placeholders for your own registered sources.

```text
POST /api/activity-events
X-OpenRhen-Token: <token>
Content-Type: application/json

{"schema": 1, "device": "collector-1", "events": [
  {"id": "mid:4f2a91@mail.example.com", "source": "demo-inbox", "kind": "message",
   "start": "2026-11-08T10:15:42Z", "content": "Can you send the draft by Friday?",
   "attrs": {"message_id": "<4f2a91@Mail.Example.com>", "from": "alex@example.com",
             "to": ["me@example.com"], "direction": "in", "channel": "inbox-main",
             "thread_id": "t-118", "subject": "Draft"}}
]}
```

By default the source's content gate is off: the server stores the row without `content` and counts it in `contentDropped`. The owner turns text on for the source with `PUT /api/activity-sources/<source>` and `{"contentEnabled": true}`. The row is stored either way (who, when, channel), so a message is never lost for lack of consent; only its text is.

## 2. Fields

Every message has `kind: "message"`. `start` is the time it was sent (RFC 3339, required; an instant, so no `end`). `content` is the message text. Everything else is in `attrs`, a closed list: any other attr is rejected with the allowed list.

| attr | meaning |
|---|---|
| `from` | Required. The sender as the source names it, 1 to 200 characters. An address is lower-cased by the server. |
| `message_id` | The source's own id for the message (an RFC 5322 `Message-ID`, or a chat message id), 1 to 200 characters. Strongly recommended. The server stores it normalised (see section 3). |
| `to` | Recipients, a list of at most 20, each as the source names them. |
| `from_self` | `true` when you sent it. |
| `direction` | `in` or `out`. |
| `channel` | An opaque label for the mailbox, chat or space, at most 128 characters. |
| `thread_id` | The source's thread or conversation id. |
| `subject` | At most 200 characters. |

`attrs.fp` is computed by the server and never sent. A post that carries it is rejected ("attrs.fp is computed by the server; leave fp out."). A source that can send no text at all (a notification feed) sends `message_id`, `from`, `start` and `channel`, with no `content`: it is stored, keyed by the id, with no `fp`.

## 3. Keys, and why the same message is safe to post twice

The event `id` must be the canonical key. The server works it out from your attrs and rejects any other, stating the one it expected, so a collector that is unsure can post once and read the answer.

- **With `message_id`:** `mid:<normalised id>`. Normalising: trim; strip one pair of angle brackets; lower-case only the part after the last `@` (a local part is case-sensitive); an id with no `@` is used as given. So `<4f2a91@Mail.Example.com>` is `mid:4f2a91@mail.example.com`. If that key would pass 200 characters it is `mid:` followed by 40 hex characters of the sha256 of the normalised id.
- **Without `message_id`:** `fp:<40 hex>`, the sha256 of the JSON array `[sender, sent time floored to the UTC minute, text]` with the sender and text normalised as in section 4. This needs `content`; a message with neither an id nor text is rejected with this fix.

The store keeps the first write of a key and ignores later ones, so re-posting a message (a retry, an overlapping window) is `alreadyHeld`: never an error, never a change. Keep your own cursor and retry queue; OpenRhen keeps no collector state.

## 4. The fingerprint `attrs.fp`

Every message that carries usable text gets `attrs.fp`: the first 32 hex characters of sha256 over the JSON array `[normalised sender, normalised text]`. The server computes it from the text you sent, before the content gate can drop the text, so a source whose gate is off still has a fingerprint. Time is not in it. Normalising is, for both: Unicode NFKC; lower-case; zero-width characters (U+200B to U+200D, U+2060) and the byte order mark (U+FEFF) removed; every run of whitespace one space; trimmed. Text is cut to its first 8192 code points. Text that normalises to nothing gives no `fp`.

`platform/contracts/message-fingerprint-vectors.v1.json` holds frozen test vectors for the fingerprint and for both key forms; check a collector in any language against it. A change to a value in that file would change every stored fingerprint, so it is pinned by a test.

The fingerprint is what lets a later change recognise the same message arriving through two routes (a collector and a paste). Until the store compares fingerprints, a copy posted twice under different keys is stored twice; the store change is separate and the fingerprint is already recorded on each row so it can be applied to rows held today. Known limits, so you are not surprised:

- A display name against an address is a different sender, so the fingerprints differ and both copies are kept. The plan matcher later absorbs the second.
- Two real messages with the same text from the same sender a second apart are both kept when they carry their own ids (source ids are trusted).
- The fingerprint is a hash of sender plus text. A guessable stock phrase can be confirmed by someone who holds the database, which is the limit stated for fact ids too.

## 5. Reporting how far you have read: coverage and heartbeat

A quiet inbox and a dead collector look the same unless the collector says how far it has read. It does that with two cross-family kinds, `coverage` and `heartbeat`. Today a source takes them only when its registry entry has an `availability` block (a heartbeat needs delivery `live` or `periodic`; a coverage row needs a feed marked `complete`); a later change lets a `message@1` source take them without inventing a signal. The shapes below are the ones the server validates now.

**Coverage, "read up to X".** After you have read the source up to instant X and every message in the window was accepted, post one event:

```text
{"id": "cov:inbox-main:2026-11-08T09:00:00.000Z:2026-11-08T10:00:00.000Z", "source": "demo-inbox",
 "kind": "coverage", "start": "2026-11-08T09:00:00Z", "end": "2026-11-08T10:00:00Z",
 "attrs": {"complete": true, "scope": "inbox-main"}}
```

`start` is where your previous window ended and `end` is X. The `id` is `cov:<scope>:<start>:<end>` with both times as `YYYY-MM-DDTHH:MM:SS.sssZ` (`cov:_:` when you send no scope), plus `:r<rev>` if you send `attrs.rev` to restate a window. Rules: `complete` must be `true`; a window is at most 31 days (a long outage is several windows); `end` may not be more than 5 minutes ahead of the server clock; a live post may start at most 400 days back (older windows go inside an import); no `content`. Send it in the same batch as the messages it covers, or after them. The server refuses a coverage row when another event of the same source in the batch was rejected, so a window is never declared complete over rows that were not stored; fix the rejection and send the batch again. The covered-up-to point for a source and scope is the latest `end` of its coverage rows. Post one coverage row per scope at most hourly, not per poll.

**Heartbeat, "I am alive".** One row per hour per device: `{"id": "hb:collector-1:2026-11-08T10:ok", "source": "demo-inbox", "kind": "heartbeat", "start": "2026-11-08T10:07:00Z", "attrs": {"status": "ok"}}`. The `id` is `hb:<batch device>:<YYYY-MM-DDTHH>:<status>`, using the batch's `device` (`_` when you send none). `status` is `ok` or `error`; an `error` may carry `attrs.error` text of at most 200 characters. Alive but not advancing (an `ok` heartbeat and no new coverage) and failing (an `error` heartbeat) are different things for the owner to act on.

## 6. How the older mail source relates

The activity store's existing mail source keeps its own shape (`thread_id`, a source-specific id, `from`, `to`, `from_self`, `direction`, `labels`, `subject`, plus header and calendar attrs) and its own readers; none of that changes and its rows keep working. `message@1` is additive. It uses the same field names where they overlap (`thread_id`, `from`, `to`, `from_self`, `direction`, `subject`) and the same `message_id` name that the mail classifier reads, so the existing mail collector can adopt the family later, by registering under it, without a rewrite of the fields it already sends. Until then its rows have no `attrs.fp` and no `mid:` key, and nothing here reads them differently. A new collector should use `message@1` from the start.

## 7. Check your post

Every entry in `rejected` names the field and the fix; treat it as a bug to fix, never as something to retry. Batch by bytes (at most 1.5 MB per request, the request cap is 2 MB), at most 1000 events per request. The owner sees the source's last event and ingest time in `GET /api/activity-events/summary`.
