# Posting messages

You need this when you build your own collector that sends messages (a mailbox, a chat, a notification feed) to the activity store, so the plan can later learn what people asked of you.

OpenRhen defines what a message looks like and where it is posted. It has no poller, adapter or provider key: you write the collector, in whatever language and against whatever mailbox, chat or feed you use, and post to `POST /api/activity-events`. Message rows are context for a predictor. They never change what the plan allows, and the planning engine cannot read them.

The family is called `message@1`. The rules the server enforces are in `platform/contracts/src/activity-message.ts`, and each rejection names the field and the fix. The store is described in [Activity store](../architecture/activity-store.md).

## 1. Register a source and post

A message source is not built in. It is registered by an extension, under a name that starts with the extension's id, with the family `message@1` and the one kind `message`. An `availability` block is optional for a message source: it takes heartbeat and coverage without one, and adds one only to declare its own cadence (`expectedEveryMinutes` or `silentAfterMinutes`, which set when the portal calls it late; see section 5). A source outside the family needs the block to post either (see [Writing a connection](../architecture/writing-a-connection.md)). Create a token for your collector with the **activity-capture** preset (Settings, Agent tokens) and post with the `X-OpenRhen-Token` header. The names below (`demo-inbox`, `demo-chat`) are placeholders for your own registered sources.

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

Every message has `kind: "message"`. `start` is the time it was sent (RFC 3339, required; an instant, so no `end`). `content` is the message text. `start` must be after 1990-01-01 (an unset or zero clock is refused). Everything else is in `attrs`, a closed list: any other attr is rejected with the allowed list. `from`, each `to`, `subject`, `channel`, `thread_id` and `message_id` reach agent-facing output, so each must be plain text on one line: a newline, tab or other control character, a line or paragraph separator, a zero-width character (U+200B, U+2060, U+FEFF) or a text-reordering one (bidirectional embeddings, overrides and isolates, tag characters) is rejected naming the field. A subject that arrives as a folded header (broken over several lines) is rejected with the instruction to unfold it into one line. ZWNJ and ZWJ stay legal because Persian, Arabic and Indic words need them. Every length limit below counts characters as code points, so an emoji is one character, not two. The server trims each of these before storing it.

| attr | meaning |
|---|---|
| `from` | Required. The sender as the source names it, 1 to 200 characters. An address is lower-cased by the server. |
| `message_id` | The source's own id for the message (an RFC 5322 `Message-ID`, or a chat message id), 1 to 200 characters, with no whitespace inside it. Strongly recommended. The server stores it normalised (see section 3). |
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

**Be plain about the no-id key.** It is a guess at identity, not an identity. Two genuinely different messages with the same sender and the same normalised text in the same UTC minute ("ok" twice, "thanks" twice) get the same key, and the second is silently dropped as `alreadyHeld`. And it removes few pasted duplicates: a copy of the same message pasted later, with a different sent time or a different sender spelling, gets a different key and is stored again. Send `message_id` whenever the source has any id at all; use the no-id key only for a feed that truly has none.

**The serialisation is exact.** Both hashed arrays are `JSON.stringify` output: compact (no space after `,` or `:`), strings in UTF-8 with non-ASCII characters written as themselves and never as `\uXXXX` escapes, and only the characters JSON requires (`"`, `\`, controls) escaped. The hash is over those UTF-8 bytes. In Python that is `json.dumps(parts, ensure_ascii=False, separators=(",", ":"))`; the default `ensure_ascii=True` escapes every non-ASCII character and makes every `fp:` key and `fp` for such text wrong, so the server rejects the post. The vectors file has non-ASCII rows to check against, as well as a `+11:00` start (the minute is taken in UTC), the empty string, text over 8192 code points, a soft hyphen (NFKC keeps it, so it changes the hash) and a precomposed/decomposed pair that agree.

The store keeps the first write of a key and ignores later ones, so re-posting a message (a retry, an overlapping window) is `alreadyHeld`: never an error, never a change. Keep your own cursor and retry queue; OpenRhen keeps no collector state.

## 4. The fingerprint `attrs.fp`

Every message that carries usable text gets `attrs.fp`: the first 32 hex characters of sha256 over the JSON array `[normalised sender, normalised text]`. The server computes it from the text you sent, before the content gate can drop the text, so a source whose gate is off still has a fingerprint. **Time is not in it, on purpose.** A time bucket in the hash would give one message two fingerprints whenever its two copies fall either side of a bucket edge or carry different offsets or clock skew, which is exactly the case the fingerprint exists for. So `fp` is only a candidate key: any comparison of two rows MUST also require their sent times to be within 60 seconds (`MESSAGE_FINGERPRINT_TIME_TOLERANCE_SECONDS`), and two rows with an equal `fp` and times further apart are different messages (a person sending "ok" on Monday and Tuesday). That range check is not in the fingerprint and not yet in the store; it will live in the cross-source lookup of slice B2 (`docs/architecture/activity-store.md`). Until it exists nothing may merge rows on `fp` alone. Normalising is, for both: Unicode NFKC; lower-case; zero-width characters (U+200B to U+200D, U+2060) and the byte order mark (U+FEFF) removed; every run of whitespace one space; trimmed. Text is cut to its first 8192 code points. Text that normalises to nothing gives no `fp`.

`platform/contracts/message-fingerprint-vectors.v1.json` holds frozen test vectors for the fingerprint and for both key forms; check a collector in any language against it. A change to a value in that file would change every stored fingerprint, so it is pinned by a test.

The fingerprint is what lets a later change recognise the same message arriving through two routes (a collector and a paste). Until the store compares fingerprints, a copy posted twice under different keys is stored twice; the store change is separate and the fingerprint is already recorded on each row so it can be applied to rows held today. Known limits, so you are not surprised:

- A display name against an address is a different sender, so the fingerprints differ and both copies are kept. The plan matcher later absorbs the second.
- Two real messages with the same text from the same sender a second apart are both kept when they carry their own ids (source ids are trusted).
- The fingerprint is a hash of sender plus text. A guessable stock phrase can be confirmed by someone who holds the database, which is the limit stated for fact ids too.

## 5. Reporting how far you have read: coverage and heartbeat

A quiet inbox and a dead collector look the same unless the collector says how far it has read. It does that with two cross-family kinds, `coverage` and `heartbeat`. A source in the `message@1` family always takes both, with no `availability` block needed. A source outside the family takes a heartbeat only when its registry entry has an `availability` block with delivery `live` or `periodic`, and a coverage row only when that block has a feed marked `complete` or no feeds. A message source must name the scope of every coverage row. The shapes below are the ones the server validates now.

**Coverage, "read up to X".** After you have read the source up to instant X and every message in the window was accepted, post one event:

```text
{"id": "cov:inbox-main:2026-11-08T09:00:00.000Z:2026-11-08T10:00:00.000Z", "source": "demo-inbox",
 "kind": "coverage", "start": "2026-11-08T09:00:00Z", "end": "2026-11-08T10:00:00Z",
 "attrs": {"complete": true, "scope": "inbox-main"}}
```

`start` is where your previous window ended and `end` is X. The `id` is `cov:<scope>:<start>:<end>` with both times as `YYYY-MM-DDTHH:MM:SS.sssZ` (`cov:_:` when you send no scope). plus `:r<rev>` if you send `attrs.rev` to restate a window. A scope is compared exactly, so `Inbox` and `inbox` are two scopes (both are accepted, with two ids). It must be sent trimmed, must not contain `:` (the id would be ambiguous) and must not contain control, zero-width or text-reordering characters (ZWNJ and ZWJ are fine). Rules: `complete` must be `true`; a window is at most 31 days (a long outage is several windows); `end` may not be more than 5 minutes ahead of the server clock; a live post may start at most 400 days back (older windows go inside an import); no `content`. Send it in the same batch as the messages it covers, or after them. The server refuses a coverage row when another event of the same source in the batch was rejected, so a window is never declared complete over rows that were not stored; fix the rejection and send the batch again. The covered-up-to point for a source and scope is the latest `end` of its coverage rows. Post one coverage row per scope at most hourly, not per poll.

**Heartbeat, "I am alive".** One row per hour per device: `{"id": "hb:collector-1:2026-11-08T10:ok", "source": "demo-inbox", "kind": "heartbeat", "start": "2026-11-08T10:07:00Z", "attrs": {"status": "ok"}}`. The `id` is `hb:<batch device>:<YYYY-MM-DDTHH>:<status>`, using the batch's `device` (`_` when you send none). `status` is `ok` or `error`; an `error` may carry `attrs.error` text of at most 200 characters. Alive but not advancing (an `ok` heartbeat and no new coverage) and failing (an `error` heartbeat) are different things for the owner to act on.

**How the portal reads them.** Once a source has posted a coverage row or a heartbeat, its freshness is how far it has been read, not when its last message arrived: a quiet inbox with a live collector is fresh, a stuck collector goes late. Heartbeat and coverage rows are never counted as messages arriving. Each scope's covered-up-to point is the latest `end` of its coverage rows; the source is read only as far as its slowest scope (a scope that stopped reporting more than 31 days before the newest one is shown as retired and no longer holds the source back). Holes, windows nobody claimed inside the last 14 days, are shown as a count. The source is late when it is read up to more than T ago and stale at 2T, where T is the first that applies of the owner's setting (arrives in a later change), your declared `silentAfterMinutes`, else 3 x your `expectedEveryMinutes`, the entry's own number, the rhythm learned from your coverage posts (20 hourly buckets needed), and finally 12 hours. `rhen sources <id>` shows each scope's covered-up-to time, the newest heartbeat and the threshold in use with where it came from. A late or stale source raises the `source_late` item on `rhen doctor` and in the attention feed; it is blocking when the source can change the plan and is stale on a stated threshold. An `error` heartbeat newer than the covered-up-to point is shown as failing, with your error text. `rhen doctor` also states, in one sentence, how far the plan's inputs are read when a source that can change the plan is behind.

**Reporting what became of each message.** A reader or reconciler that processes your messages records one run per pass in the run log as provider `reconcile:<source>`, with a summary `{"endStates": {"applied": n, "duplicate": n, "asked": n, "no_effect": n, "unresolved": n}, "noEffectReasons": {"<reason in your words>": n}, "unresolvedKeys": ["<event key>"]}`. `messages` is the sum of `endStates`; `noEffectReasons` and `unresolvedKeys` are optional (at most 20 each). `rhen doctor` then reports, per message source, the inbound messages collected in 30 days against the messages that reached an end state, so a gap between the two is visible instead of silent. `unresolved` is not a decision and stays in the gap; the gap is approximate until the reconciler records `no_effect` for the messages it skips. `rhen doctor` also says when a message source is not covered by the plan-inputs statement because it reports no coverage or is not marked as changing the plan.

## 6. How the older mail source relates

The activity store's existing mail source keeps its own shape (`thread_id`, a source-specific id, `from`, `to`, `from_self`, `direction`, `labels`, `subject`, plus header and calendar attrs) and its own readers; none of that changes and its rows keep working. `message@1` is additive. It uses the same field names where they overlap (`thread_id`, `from`, `to`, `from_self`, `direction`, `subject`) and the same `message_id` name that the mail classifier reads, so the existing mail collector can adopt the family later, by registering under it, without a rewrite of the fields it already sends. Until then its rows have no `attrs.fp` and no `mid:` key, and nothing here reads them differently. A new collector should use `message@1` from the start.

## 7. Check your post

Every entry in `rejected` names the field and the fix; treat it as a bug to fix, never as something to retry. Batch by bytes (at most 1.5 MB per request, the request cap is 2 MB), at most 1000 events per request. The owner sees the source's last event and ingest time in `GET /api/activity-events/summary`.
