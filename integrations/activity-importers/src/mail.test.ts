import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, makeZip } from "./fixtures.js";
import { planImport } from "./plan.js";
import { parseMailFile, type MailKeying, type MailOptions } from "./parsers/mail.js";
import { ImportReadError, newStats, type ByteSource } from "./types.js";

/** Stand-in for the contracts' key rules (the importers import no workspace package); the CLI test runs the real ones. */
const keying: MailKeying = {
  normaliseMessageId(raw) {
    let id = raw.trim();
    if (id.startsWith("<") && id.endsWith(">")) id = id.slice(1, -1).trim();
    const at = id.lastIndexOf("@");
    return at < 0 ? id : `${id.slice(0, at)}@${id.slice(at + 1).toLowerCase()}`;
  },
  isRfcMessageId: (id) => /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(id),
  canonicalMessageKey({ messageId, sender, tsStart, content }) {
    if (messageId) return `mid:${messageId}`;
    if (!content || content.trim() === "") return undefined;
    const parts = JSON.stringify([
      sender.toLowerCase(),
      tsStart.toISOString().slice(0, 16),
      content.trim().toLowerCase()
    ]);
    return `fp:${createHash("sha256").update(parts).digest("hex").slice(0, 40)}`;
  },
  messageIdMaxChars: 200,
  contentMaxBytes: 64 * 1024
};

const now = new Date("2026-11-10T00:00:00Z");
const options = (extra: Partial<MailOptions> = {}): MailOptions => ({
  source: "inbox-import",
  keying,
  maxMessageBytes: 1024 * 1024,
  now,
  seen: new Set(),
  ...extra
});
const ENV = "From sender@example.test Mon Jan  5 10:00:00 2026\n";
const msg = (headers: string[], body = "Hello there.\n") => `${headers.join("\n")}\n\n${body}`;
const basic = (id: string, extra: string[] = [], body?: string) =>
  msg(
    [
      "From: Alex <Alex@Example.test>",
      "To: me@example.test",
      `Message-ID: <${id}>`,
      "Date: Mon, 5 Jan 2026 10:00:00 +1100",
      "Subject: Hi",
      ...extra
    ],
    body
  );
const mbox = (...messages: string[]) => messages.map((m) => ENV + m + "\n").join("");

async function* bytes(text: string | Buffer, size = 1 << 20): ByteSource {
  const data = Buffer.isBuffer(text) ? text : Buffer.from(text, "latin1");
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size);
}
const run = async (text: string | Buffer, opts = options(), name = "a.mbox", size?: number) => {
  const stats = newStats();
  const events = await collect(parseMailFile(bytes(text, size), { name }, opts, stats));
  return { events, stats };
};
const fails = async (text: string | Buffer, opts = options(), name = "a.mbox") => {
  const error = await run(text, opts, name).then(
    () => null,
    (e) => e
  );
  expect(error).toBeInstanceOf(ImportReadError);
  return (error as Error).message;
};

describe("mbox reading", () => {
  it("splits on From lines and unescapes mboxrd levels", async () => {
    const { events } = await run(
      mbox(basic("a@x.example", [], "one\n>From me\n>>From you\nnot a separator: From x\n"), basic("b@x.example"))
    );
    expect(events.map((e) => e.id)).toEqual(["mid:a@x.example", "mid:b@x.example"]);
    expect(events[0]!.content).toBe("one\nFrom me\n>From you\nnot a separator: From x");
  });

  it("gives the same events however the bytes are chunked", async () => {
    const text = mbox(basic("a@x.example"), basic("b@x.example", [], "=?x?"));
    const whole = (await run(text)).events;
    for (const size of [1, 2, 3, 7, 64]) expect((await run(text, options(), "a.mbox", size)).events).toEqual(whole);
  });

  it("is lazy: the first event is out before the rest of the file is read", async () => {
    let read = 0;
    async function* source(): ByteSource {
      for (let i = 0; i < 2000; i++) {
        read += 1;
        yield Buffer.from(ENV + basic(`m${i}@x.example`) + "\n");
      }
    }
    const iterator = parseMailFile(source(), { name: "big.mbox" }, options(), newStats());
    await iterator.next();
    expect(read).toBeLessThan(5);
    await iterator.return(undefined);
  });

  it("posts the same keys on a re-run", async () => {
    const text = mbox(basic("a@x.example"), basic("b@x.example"));
    const first = await run(text);
    const second = await run(text);
    expect(second.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
  });
});

describe("headers", () => {
  it("unfolds and decodes encoded words, with charsets", async () => {
    const { events } = await run(
      mbox(
        basic("h@x.example", [
          "Subject: =?utf-8?B?Q2Fmw6k=?= and =?iso-8859-1?Q?caf=E9?=",
          " =?UTF-8?q?_na=C3=AFve?= folded",
          "\tmore"
        ])
          // the basic() Subject: Hi header is replaced below
          .replace("Subject: Hi\n", "")
      )
    );
    expect(events[0]!.attrs.subject).toBe("Café and café naïve folded more");
  });

  it("maps sender, recipients, thread and time to the closed attrs", async () => {
    const { events } = await run(
      mbox(
        msg([
          'From: "Doe, Jane" <Jane@Example.test>',
          'To: "A, B" <b@example.test>, c@example.test (Carl)',
          "Cc: d@example.test",
          "Message-ID: <Child@Mail.Example.TEST>",
          "In-Reply-To: <parent@x.example>",
          "References: <root@x.example> <parent@x.example>",
          "Date: Mon, 5 Jan 2026 10:00:00 +1100",
          "Subject: Re: plan"
        ])
      )
    );
    const e = events[0]!;
    expect(e).toMatchObject({
      id: "mid:Child@mail.example.test",
      source: "inbox-import",
      kind: "message",
      start: "2026-01-04T23:00:00.000Z",
      tzOffsetMin: 660,
      attrs: {
        message_id: "Child@mail.example.test",
        from: "jane@example.test",
        to: ["b@example.test", "c@example.test", "d@example.test"],
        thread_id: "root@x.example",
        subject: "Re: plan",
        channel: "a"
      }
    });
    expect(Object.keys(e.attrs).sort()).toEqual(["channel", "from", "message_id", "subject", "thread_id", "to"]);
  });

  it("uses its own id as the thread id when it replies to nothing", async () => {
    const { events } = await run(mbox(basic("solo@x.example")));
    expect(events[0]!.attrs.thread_id).toBe("solo@x.example");
  });

  it("marks self mail out", async () => {
    const { events } = await run(mbox(basic("s@x.example")), options({ selfAddresses: ["alex@example.test"] }));
    expect(events[0]!.attrs).toMatchObject({ from_self: true, direction: "out" });
  });
});

describe("dates", () => {
  it("falls back to the separator date with a counted warning when Date is missing", async () => {
    const { events, stats } = await run(mbox(basic("d@x.example").replace(/Date:.*\n/, "")));
    expect(events[0]!.start).toBe("2026-01-05T10:00:00.000Z");
    expect(events[0]!.approximate).toBe(true);
    expect(stats.warnings["Date header is missing; the separator line's date was used"]).toBe(1);
  });

  it("treats an absurd or unparseable Date as bad, never as truth", async () => {
    const a = await run(mbox(basic("d1@x.example").replace(/Date:.*/, "Date: Mon, 5 Jan 1970 00:00:00 +0000")));
    expect(
      a.stats.warnings["Date header is absurd (before 1990 or in the future); the separator line's date was used"]
    ).toBe(1);
    const b = await run(mbox(basic("d2@x.example").replace(/Date:.*/, "Date: yesterday-ish")));
    expect(b.stats.warnings["Date header cannot be parsed; the separator line's date was used"]).toBe(1);
    const c = await run(mbox(basic("d3@x.example").replace(/Date:.*/, "Date: Mon, 5 Jan 2031 00:00:00 +0000")));
    expect(c.events[0]!.start).toBe("2026-01-05T10:00:00.000Z");
  });

  it("skips and counts a message with no usable date anywhere", async () => {
    const text = "From x@y.example Mon Jan  5 99:99:99 2026\n" + basic("n@x.example").replace(/Date:.*\n/, "");
    const { events, stats } = await run(text);
    expect(events).toHaveLength(0);
    expect(stats.reasons["no usable date in the Date header, the separator line or Received"]).toBe(1);
  });
});

describe("bodies", () => {
  it("prefers text/plain in multipart/alternative and counts attachments", async () => {
    const body = [
      "--outer",
      "Content-Type: multipart/alternative; boundary=inner",
      "",
      "--inner",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>HTML version</p>",
      "--inner",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Plain version",
      "--inner--",
      "--outer",
      'Content-Type: application/pdf; name="x.pdf"',
      "Content-Disposition: attachment; filename=x.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQK",
      "--outer--",
      ""
    ].join("\n");
    const { events, stats } = await run(
      mbox(basic("m@x.example", ["Content-Type: multipart/mixed; boundary=outer"], body))
    );
    expect(events[0]!.content).toBe("Plain version");
    expect(stats.counts["attachments ignored"]).toBe(1);
  });

  it("strips html to text when it is all there is", async () => {
    const html =
      "<html><head><style>p{}</style></head><body><script>bad()</script><p>Fish &amp; chips&nbsp;&#169;</p><p>Line<br>two</p><!-- c --></body></html>";
    const { events } = await run(mbox(basic("h@x.example", ["Content-Type: text/html; charset=utf-8"], html + "\n")));
    expect(events[0]!.content).toBe("Fish & chips ©\n\nLine\ntwo");
  });

  it("decodes quoted-printable and base64 in their charsets", async () => {
    const qp = await run(
      mbox(
        basic(
          "q@x.example",
          ["Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: quoted-printable"],
          "caf=E9 soft=\nbreak =3D\n"
        )
      )
    );
    expect(qp.events[0]!.content).toBe("café softbreak =");
    const b64 = Buffer.from("naïve ☃", "utf8").toString("base64");
    const b = await run(
      mbox(
        basic(
          "b@x.example",
          ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"],
          b64 + "\n"
        )
      )
    );
    expect(b.events[0]!.content).toBe("naïve ☃");
  });

  it("cuts text over the content limit and says so", async () => {
    const { events, stats } = await run(mbox(basic("l@x.example", [], "word ".repeat(30000) + "\n")));
    expect(Buffer.byteLength(events[0]!.content!)).toBeLessThanOrEqual(64 * 1024);
    expect(Object.keys(stats.warnings).some((w) => w.startsWith("text was cut"))).toBe(true);
  });
});

describe("keys", () => {
  it("keys a message with no Message-ID, or a non-RFC one, by the fp rule", async () => {
    const none = await run(mbox(basic("x@x.example").replace(/Message-ID:.*\n/, "")));
    const bad = await run(mbox(basic("nodomain")));
    expect(none.events[0]!.id).toMatch(/^fp:[0-9a-f]{40}$/);
    expect(bad.events[0]!.id).toBe(none.events[0]!.id);
    expect(none.events[0]!.attrs.message_id).toBeUndefined();
    expect(bad.stats.warnings["Message-ID is not RFC-shaped; keyed by sender, minute and text"]).toBe(1);
  });

  it("keys a non-RFC id with no text by the id itself, and warns", async () => {
    const { events, stats } = await run(mbox(basic("nodomain", [], "")));
    expect(events[0]!.id).toBe("mid:nodomain");
    expect(
      stats.warnings[
        "Message-ID is not RFC-shaped and there is no text; keyed by the id (unique only inside this source)"
      ]
    ).toBe(1);
  });

  it("skips and counts a message that can be keyed neither way", async () => {
    const { events, stats } = await run(mbox(basic("x@x.example", [], "").replace(/Message-ID:.*\n/, "")));
    expect(events).toHaveLength(0);
    expect(stats.skipped).toBe(1);
    expect(stats.reasons["no Message-ID and no text, so there is nothing to key it on"]).toBe(1);
  });

  it("keeps the first copy of a Message-ID across files and counts the rest", async () => {
    const shared = options();
    const first = await run(mbox(basic("dup@x.example", [], "first")), shared, "Inbox.mbox");
    const second = await run(mbox(basic("dup@X.EXAMPLE", [], "second"), basic("new@x.example")), shared, "Sent.mbox");
    expect(first.events).toHaveLength(1);
    expect(second.events.map((e) => e.id)).toEqual(["mid:new@x.example"]);
    expect(second.stats.counts["duplicate Message-ID in this import (first copy kept)"]).toBe(1);
    expect(second.stats.ignored).toBe(1);
  });
});

describe("failing loudly", () => {
  it("names the file and offset when the file is not an mbox", async () => {
    const m = await fails("Subject: just a message\n\nbody\n", options(), "notes.mbox");
    expect(m).toMatch(/^notes\.mbox: /);
    expect(m).toMatch(/byte 0/);
    expect(m).toMatch(/\.eml/);
  });

  it("names the message and offset for garbage where a header should be", async () => {
    const m = await fails(mbox(basic("a@x.example")) + ENV + "\u0000\u0001garbage garbage\n\nbody\n");
    expect(m).toMatch(/message 2/);
    expect(m).toMatch(/byte \d+/);
  });

  it("refuses a truncated multipart", async () => {
    const body = "--b\nContent-Type: text/plain\n\ntext\n";
    const m = await fails(mbox(basic("t@x.example", ["Content-Type: multipart/mixed; boundary=b"], body)));
    expect(m).toMatch(/message 1/);
    expect(m).toMatch(/closing boundary/);
  });

  it("refuses an unknown transfer encoding and an unknown charset", async () => {
    expect(await fails(mbox(basic("u@x.example", ["Content-Transfer-Encoding: x-uuencode"])))).toMatch(/x-uuencode/);
    expect(await fails(mbox(basic("c@x.example", ["Content-Type: text/plain; charset=x-no-such"])))).toMatch(
      /x-no-such/
    );
  });

  it("errors, not truncates, on a message over the cap", async () => {
    const m = await fails(
      mbox(basic("big@x.example", [], "x".repeat(5000) + "\n")),
      options({ maxMessageBytes: 2000 })
    );
    expect(m).toMatch(/message 1/);
    expect(m).toMatch(/2000 bytes/);
    expect(m).toMatch(/--max-message-mib/);
  });
});

describe("single .eml", () => {
  it("reads one message with no separator line", async () => {
    const { events } = await run(
      basic("e@x.example").replace(/Date:.*/, "Date: Mon, 5 Jan 2026 10:00:00 +0000"),
      options(),
      "one.eml"
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("mid:e@x.example");
  });
});

describe("planning a mail import", () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-plan-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const plan = (path: string, source = "inbox-import") => planImport("mail", path, { mail: { source, keying, now } });

  it("reads every mbox and eml inside a zip, in path order, as one job under the caller's source, and ignores the rest", async () => {
    const path = join(dir, "export.zip");
    writeFileSync(
      path,
      makeZip([
        { name: "export/Mail/B.mbox", data: mbox(basic("b@x.example")) },
        { name: "export/Mail/A.mbox", data: mbox(basic("a@x.example")) },
        { name: "export/Mail/notes.txt", data: "not mail" },
        { name: "export/Mail/C.eml", data: basic("c@x.example") }
      ])
    );
    const p = await plan(path);
    expect(p.jobs).toHaveLength(1);
    const job = p.jobs[0]!;
    if (job.kind !== "events") throw new Error("expected events");
    expect(job.source).toBe("inbox-import");
    expect(job.files).toEqual(["export/Mail/A.mbox", "export/Mail/B.mbox", "export/Mail/C.eml"]);
    const events = await collect(job.events());
    expect(events.map((e) => e.id)).toEqual(["mid:a@x.example", "mid:b@x.example", "mid:c@x.example"]);
    expect(events.map((e) => e.attrs.channel)).toEqual(["A", "B", "C"]);
  });

  it("names the file in an error from inside a zip, and records the same file under another source as another import", async () => {
    const path = join(dir, "bad.zip");
    writeFileSync(path, makeZip([{ name: "m/x.mbox", data: "nothing like mail\n" }]));
    const p = await plan(path);
    const job = p.jobs[0]!;
    if (job.kind !== "events") throw new Error("expected events");
    await expect(collect(job.events())).rejects.toThrow(/^m\/x\.mbox: not an mbox file: byte 0/);
    const file = join(dir, "one.mbox");
    writeFileSync(file, mbox(basic("a@x.example")));
    const a = (await plan(file, "src-a")).jobs[0]!;
    const planB = await plan(file, "src-b");
    const b = planB.jobs[0]!;
    if (a.kind !== "events" || b.kind !== "events") throw new Error("expected events");
    expect(await planB.sha256For(a)).not.toBe(await planB.sha256For(b));
  });

  it("asks for a source and finds nothing to read", async () => {
    await expect(planImport("mail", join(dir, "one.mbox"))).rejects.toThrow(/--source/);
    await expect(plan(join(dir, "does-not-exist"))).rejects.toThrow(/does not exist/);
  });
});
