import { describe, expect, it } from "vitest";
import { resolveWhen, WHEN_LANGUAGES, WHEN_MAX_TEXT_CODE_POINTS } from "./resolve-when.js";

const SYDNEY_SUN = "2026-11-08T01:00:00Z"; // Sunday 8 Nov 2026, 12:00 in Sydney
const when = (text: string, tz = "Australia/Sydney", refTime = SYDNEY_SUN, lang?: string, textStart?: number) => {
  const result = resolveWhen({ text, refTime, tz, lang, textStart });
  if (!result.ok) throw new Error(result.reason);
  return result.when;
};

describe("resolveWhen: relative dates against the message time and the owner's zone", () => {
  it("'tomorrow at 3pm' is the owner's tomorrow, one reading, not ambiguous", () => {
    expect(when("tomorrow at 3pm")).toEqual({
      raw: [0, 15],
      ref_time: SYDNEY_SUN,
      tz: "Australia/Sydney",
      candidates: [{ start: "2026-11-09T15:00:00+11:00" }],
      ambiguous: false
    });
  });

  it("uses the owner's wall clock for 'tomorrow' near midnight UTC", () => {
    // 23:30 UTC on the 8th is 10:30 on the 9th in Sydney, so tomorrow is the 10th there and the 8th in New York.
    expect(when("tomorrow at 9am", "Australia/Sydney", "2026-11-08T23:30:00Z")?.candidates[0]?.start).toBe(
      "2026-11-10T09:00:00+11:00"
    );
    expect(when("tomorrow at 9am", "America/New_York", "2026-11-08T23:30:00Z")?.candidates[0]?.start).toBe(
      "2026-11-09T09:00:00-05:00"
    );
  });

  it("'next Friday' has no time of day: one all-day candidate (midnight to midnight) and ambiguous", () => {
    expect(when("next Friday")).toEqual({
      raw: [0, 11],
      ref_time: SYDNEY_SUN,
      tz: "Australia/Sydney",
      candidates: [{ start: "2026-11-13T00:00:00+11:00", end: "2026-11-14T00:00:00+11:00" }],
      ambiguous: true
    });
  });

  it("reads a range, noon, 24-hour times and 'in 2 hours' (elapsed from the message)", () => {
    expect(when("Friday 2pm to 4pm")?.candidates).toEqual([
      { start: "2026-11-13T14:00:00+11:00", end: "2026-11-13T16:00:00+11:00" }
    ]);
    expect(when("at noon tomorrow")?.candidates).toEqual([{ start: "2026-11-09T12:00:00+11:00" }]);
    expect(when("tomorrow at 15:00")?.ambiguous).toBe(false);
    expect(when("in 2 hours")).toMatchObject({
      candidates: [{ start: "2026-11-08T14:00:00+11:00" }],
      ambiguous: false
    });
  });

  it("'tomorrow at 3' with no am/pm gives both readings, the business-hours one first, ambiguous", () => {
    expect(when("tomorrow at 3")).toMatchObject({
      candidates: [{ start: "2026-11-09T15:00:00+11:00" }, { start: "2026-11-09T03:00:00+11:00" }],
      ambiguous: true
    });
    expect(when("tomorrow at 9")?.candidates.map((c) => c.start)).toEqual([
      "2026-11-09T09:00:00+11:00",
      "2026-11-09T21:00:00+11:00"
    ]);
  });

  it("a sender-named zone is exact: 9am EST is 01:00 next day in Sydney", () => {
    expect(when("15 March 2027 9am EST")?.candidates).toEqual([{ start: "2027-03-16T01:00:00+11:00" }]);
  });
});

describe("resolveWhen: daylight saving", () => {
  it("a wall time the clocks skip is pushed forward and flagged (Sydney, 4 Oct 2026, 02:30 does not exist)", () => {
    expect(when("Sunday 2:30am", "Australia/Sydney", "2026-10-01T01:00:00Z")).toMatchObject({
      candidates: [{ start: "2026-10-04T03:30:00+11:00" }],
      ambiguous: true
    });
  });

  it("a wall time the clocks repeat has both readings, earlier first (New York, 1 Nov 2026, 01:30)", () => {
    expect(when("Sunday 1:30am", "America/New_York", "2026-10-28T01:00:00Z")).toMatchObject({
      candidates: [{ start: "2026-11-01T01:30:00-04:00" }, { start: "2026-11-01T01:30:00-05:00" }],
      ambiguous: true
    });
  });

  it("a time on the far side of a change gets that day's offset, not the reference's", () => {
    // Message sent in Sydney winter (+10:00); the meeting is after the October change to +11:00.
    expect(when("on 20 October 2026 at 3pm", "Australia/Sydney", "2026-07-01T00:00:00Z")?.candidates).toEqual([
      { start: "2026-10-20T15:00:00+11:00" }
    ]);
    expect(when("on 20 June 2027 at 3pm", "Australia/Sydney", "2027-01-05T00:00:00Z")?.candidates).toEqual([
      { start: "2027-06-20T15:00:00+10:00" }
    ]);
  });

  it("'in 6 hours' across a change is elapsed time, so the wall clock jumps", () => {
    // 2026-10-03T14:00Z = 01:00 Sydney on the 4th (+10:00); six hours later is 07:00 +11:00 = 20:00Z.
    expect(when("in 6 hours", "Australia/Sydney", "2026-10-03T15:00:00Z")?.candidates).toEqual([
      { start: "2026-10-04T08:00:00+11:00" }
    ]);
  });
});

describe("resolveWhen: ambiguity", () => {
  it("'3/4' is read month-first and day-first: both candidates, ambiguous", () => {
    expect(when("on 3/4 at 9am")?.candidates.map((c) => c.start)).toEqual([
      "2027-03-04T09:00:00+11:00",
      "2027-04-03T09:00:00+11:00"
    ]);
    expect(when("on 3/4 at 9am")?.ambiguous).toBe(true);
  });

  it("an English tag from a day-first region reads '3/4' as 3 April only", () => {
    expect(when("on 3/4 at 9am", "Australia/Sydney", SYDNEY_SUN, "en-AU")).toMatchObject({
      candidates: [{ start: "2027-04-03T09:00:00+11:00" }],
      ambiguous: false
    });
  });

  it("'13/4' cannot be month-first, so it is not flagged", () => {
    expect(when("on 13/4 at 9am", "Australia/Sydney", SYDNEY_SUN, "en")?.ambiguous).toBe(false);
  });

  it("a recurrence is flagged even though its next occurrence resolves", () => {
    expect(when("every Monday at 9am")?.ambiguous).toBe(true);
    expect(when("weekly on Friday at 4pm")?.ambiguous).toBe(true);
  });

  it("several dates in one quote keep one candidate each (at most 3) and are ambiguous", () => {
    const result = when("Monday or Tuesday or Wednesday or Thursday at 4pm");
    expect(result?.ambiguous).toBe(true);
    expect(result?.candidates.length).toBeGreaterThan(1);
    expect(result?.candidates.length).toBeLessThanOrEqual(3);
  });

  it("text with no date resolves to null", () => {
    expect(when("Can you send the report")).toBeNull();
    expect(when("")).toBeNull();
  });

  it("every candidate is a time the contract accepts: RFC 3339 with an offset", () => {
    for (const text of ["next Friday", "tomorrow at 3", "Friday 2pm to 4pm", "in 2 hours", "on 3/4 at 9am"]) {
      for (const candidate of when(text)!.candidates)
        for (const time of [candidate.start, candidate.end])
          if (time) expect(time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/);
    }
  });

  it("an offset of zero is written Z", () => {
    expect(when("tomorrow at 3pm", "UTC")?.candidates[0]?.start).toBe("2026-11-09T15:00:00Z");
  });
});

describe("resolveWhen: raw offsets point into the message in code points", () => {
  it("adds the text start and counts astral characters as one", () => {
    // "😀 Call tomorrow at 3pm": the date starts after the emoji, a space and "Call " (7 code points).
    const result = when("😀 Call tomorrow at 3pm", "Australia/Sydney", SYDNEY_SUN, "en", 100);
    expect(result?.raw).toEqual([107, 107 + "tomorrow at 3pm".length]);
  });
});

describe("resolveWhen: languages", () => {
  const cases: [string, string, string, string][] = [
    ["en", "tomorrow at 3pm", "Australia/Sydney", "2026-11-09T15:00:00+11:00"],
    ["de", "morgen um 15 Uhr", "Europe/Berlin", "2026-11-09T15:00:00+01:00"],
    ["fr", "demain à 15h", "Europe/Paris", "2026-11-09T15:00:00+01:00"],
    ["es", "mañana a las 15:00", "Europe/Madrid", "2026-11-09T15:00:00+01:00"],
    ["it", "domani alle 15", "Europe/Rome", "2026-11-09T15:00:00+01:00"],
    ["nl", "morgen om 15:00", "Europe/Amsterdam", "2026-11-09T15:00:00+01:00"],
    ["ru", "завтра в 15:00", "Europe/Moscow", "2026-11-09T15:00:00+03:00"],
    ["uk", "завтра о 15:00", "Europe/Kiev", "2026-11-09T15:00:00+02:00"],
    ["ja", "明日の15時", "Asia/Tokyo", "2026-11-09T15:00:00+09:00"],
    ["zh-CN", "明天下午3点", "Asia/Shanghai", "2026-11-09T15:00:00+08:00"],
    ["zh-TW", "明天下午3點", "Asia/Taipei", "2026-11-09T15:00:00+08:00"]
  ];
  it.each(cases)("%s: %s", (lang, text, tz, start) => {
    expect(when(text, tz, SYDNEY_SUN, lang)).toMatchObject({ candidates: [{ start }], ambiguous: false });
  });

  it("Swedish and Portuguese find the day but lose the hour, so they are all-day and ambiguous (a chrono limit)", () => {
    for (const [lang, text, tz] of [
      ["sv", "imorgon kl 15", "Europe/Stockholm"],
      ["pt", "amanhã às 15h", "Europe/Lisbon"]
    ] as const)
      expect(when(text, tz, SYDNEY_SUN, lang)?.ambiguous).toBe(true);
  });

  it("an unsupported language, or Chinese with no script or region, sets ambiguous with no candidate and no raw", () => {
    for (const lang of ["pl", "da", "xx", "zh"])
      expect(when("jutro o 15", "Europe/Warsaw", SYDNEY_SUN, lang)).toEqual({
        ref_time: SYDNEY_SUN,
        tz: "Europe/Warsaw",
        candidates: [],
        ambiguous: true
      });
  });

  it("lists exactly the languages tested above", () => {
    expect([...WHEN_LANGUAGES].sort()).toEqual([
      "de",
      "en",
      "es",
      "fr",
      "it",
      "ja",
      "nl",
      "pt",
      "ru",
      "sv",
      "uk",
      "zh"
    ]);
  });
});

describe("resolveWhen: bad input and pathological text", () => {
  it("requires the reference time to say its zone: Z or a numeric offset", () => {
    for (const refTime of [
      "2026-11-08T12:00:00",
      "2026-11-08T12:00",
      "2026-11-08",
      "2026-11-08 12:00:00Z",
      "yesterday"
    ])
      expect(resolveWhen({ text: "tomorrow", refTime, tz: "UTC" }), refTime).toEqual({
        ok: false,
        reason: "bad_ref_time"
      });
    expect(
      resolveWhen({ text: "tomorrow at 3pm", refTime: "2026-11-08T12:00:00+11:00", tz: "Australia/Sydney" })
    ).toMatchObject({ ok: true });
    expect(resolveWhen({ text: "tomorrow at 3pm", refTime: new Date(SYDNEY_SUN), tz: "UTC" })).toMatchObject({
      ok: true
    });
  });

  it("accepts only IANA zones the runtime lists, plus UTC", () => {
    for (const tz of ["EST", "+05:00", "utc", "australia/sydney", "GMT+5", "Sydney"])
      expect(resolveWhen({ text: "tomorrow", refTime: SYDNEY_SUN, tz }), tz).toEqual({ ok: false, reason: "bad_tz" });
    expect(resolveWhen({ text: "tomorrow", refTime: SYDNEY_SUN, tz: "UTC" }).ok).toBe(true);
  });

  it("an empty lang is English", () => {
    expect(when("tomorrow at 3pm", "UTC", SYDNEY_SUN, "")?.candidates).toEqual([{ start: "2026-11-09T15:00:00Z" }]);
  });

  it("refuses a bad reference time or zone by name", () => {
    expect(resolveWhen({ text: "tomorrow", refTime: "not a time", tz: "UTC" })).toEqual({
      ok: false,
      reason: "bad_ref_time"
    });
    expect(resolveWhen({ text: "tomorrow", refTime: "2026-11-08", tz: "UTC" })).toEqual({
      ok: false,
      reason: "bad_ref_time"
    });
    expect(resolveWhen({ text: "tomorrow", refTime: SYDNEY_SUN, tz: "Mars/Base" })).toEqual({
      ok: false,
      reason: "bad_tz"
    });
    expect(resolveWhen({ text: "tomorrow", refTime: SYDNEY_SUN, tz: "" })).toEqual({ ok: false, reason: "bad_tz" });
  });

  it("refuses text over the cap rather than cutting it", () => {
    const long = "tomorrow ".repeat(200);
    expect(long.length).toBeGreaterThan(WHEN_MAX_TEXT_CODE_POINTS);
    expect(resolveWhen({ text: long, refTime: SYDNEY_SUN, tz: "UTC" })).toEqual({ ok: false, reason: "text_too_long" });
    expect(resolveWhen({ text: "😀".repeat(WHEN_MAX_TEXT_CODE_POINTS + 1), refTime: SYDNEY_SUN, tz: "UTC" })).toEqual({
      ok: false,
      reason: "text_too_long"
    });
  });

  it("finishes quickly on adversarial text at the cap", () => {
    const attacks = [
      "1".repeat(WHEN_MAX_TEXT_CODE_POINTS),
      "1/".repeat(WHEN_MAX_TEXT_CODE_POINTS / 2),
      "3pm ".repeat(WHEN_MAX_TEXT_CODE_POINTS / 4),
      "on the ".repeat(WHEN_MAX_TEXT_CODE_POINTS / 7),
      "at ".repeat(WHEN_MAX_TEXT_CODE_POINTS / 3),
      `${"9".repeat(500)}:${"9".repeat(499)}`,
      "-".repeat(WHEN_MAX_TEXT_CODE_POINTS),
      " ".repeat(WHEN_MAX_TEXT_CODE_POINTS - 1) + "x",
      "Monday ".repeat(WHEN_MAX_TEXT_CODE_POINTS / 7)
    ];
    for (const lang of ["en", "de", "ja", "zh-CN", "ru"])
      for (const text of attacks) {
        const began = performance.now();
        const result = resolveWhen({
          text: text.slice(0, WHEN_MAX_TEXT_CODE_POINTS),
          refTime: SYDNEY_SUN,
          tz: "Australia/Sydney",
          lang
        });
        expect(result.ok).toBe(true);
        expect(performance.now() - began).toBeLessThan(1500);
      }
  });

  it("never throws on odd characters", () => {
    for (const text of [
      "\u0000\u0001",
      "\ud800",
      "tomorrow\u200b at 3pm",
      "0/0/0",
      "99:99",
      "31 February",
      "year 0000"
    ])
      expect(() => resolveWhen({ text, refTime: SYDNEY_SUN, tz: "UTC" })).not.toThrow();
  });
});

describe("resolveWhen: a partly read expression is never reported as a single sure reading (verifier blocking 2)", () => {
  const flagged: [string, string | undefined, string?][] = [
    ["6pm on the 14th", undefined],
    ["Sat 14th at 6pm", undefined],
    ["between 2 and 4pm tomorrow", undefined],
    ["a fortnight from now", undefined],
    ["next week or Friday at 3pm", undefined],
    ["Friday at 3pm, or Saturday morning", undefined],
    ["12.11. um 15:00", "de", "Europe/Berlin"],
    ["来週の金曜日 15時", "ja", "Asia/Tokyo"],
    ["明後日の15時", "ja", "Asia/Tokyo"],
    ["наступної п'ятниці о 15:00", "uk", "Europe/Kiev"],
    ["próxima sexta-feira às 15:00", "pt", "Europe/Lisbon"],
    ["la semaine prochaine à 15h", "fr", "Europe/Paris"],
    ["la prossima settimana alle 15", "it", "Europe/Rome"],
    ["следующей пятницы в 15:00", "ru", "Europe/Moscow"],
    ["nästa fredag kl 15", "sv", "Europe/Stockholm"],
    // A phrase in one language under another language's tag.
    ["morgen um 15 Uhr", "en"],
    ["demain à 15h", "en"],
    ["明日の15時", "en"],
    ["tomorrow at 3pm", "ja", "Asia/Tokyo"],
    ["завтра в 15:00", "de", "Europe/Berlin"]
  ];
  it.each(flagged)("%s (%s)", (text, lang, tz = "Australia/Sydney") => {
    const result = when(text, tz, SYDNEY_SUN, lang);
    expect(result, text).not.toBeNull();
    expect(result?.ambiguous, text).toBe(true);
  });

  it("keeps the part it did read as a candidate", () => {
    expect(when("6pm on the 14th")?.candidates.length).toBeGreaterThan(0);
    expect(when("12.11. um 15:00", "Europe/Berlin", SYDNEY_SUN, "de")?.candidates[0]?.start).toMatch(
      /T15:00:00\+01:00$/
    );
  });

  it("'last Friday at 3pm' is the past Friday, not the next one", () => {
    expect(when("last Friday at 3pm")).toMatchObject({
      candidates: [{ start: "2026-11-06T15:00:00+11:00" }],
      ambiguous: false
    });
    expect(when("3 days ago")).toMatchObject({ candidates: [{ start: "2026-11-05T00:00:00+11:00" }], ambiguous: true });
  });

  it("'midnight tonight' and 'tonight at midnight' are the coming midnight (start of tomorrow)", () => {
    for (const text of ["midnight tonight", "tonight at midnight", "at midnight tonight"])
      expect(when(text), text).toMatchObject({
        candidates: [{ start: "2026-11-09T00:00:00+11:00" }],
        ambiguous: false
      });
  });

  it("'Nov 3 at 3pm' said on Nov 6 is ambiguous (the date just passed), never a silent next year", () => {
    const result = when("Nov 3 at 3pm", "Australia/Sydney", "2026-11-06T01:00:00Z");
    expect(result?.ambiguous).toBe(true);
  });

  it("a month-day far from today rolls to next year without a flag ('3 January' said in November)", () => {
    expect(when("on 3 January at 3pm", "Australia/Sydney", SYDNEY_SUN)).toMatchObject({
      candidates: [{ start: "2027-01-03T15:00:00+11:00" }],
      ambiguous: false
    });
  });

  it("an end hour chrono made up is dropped: '9am Mon-Fri' is ambiguous with no end", () => {
    const result = when("9am Mon-Fri");
    expect(result?.ambiguous).toBe(true);
    expect(result?.candidates.every((c) => c.end === undefined)).toBe(true);
  });

  it("an abbreviation for more than one zone is ambiguous: CST, IST, BST", () => {
    for (const abbreviation of ["CST", "IST", "BST"])
      expect(when(`15 March 2027 9am ${abbreviation}`)?.ambiguous, abbreviation).toBe(true);
  });

  it("a fully read expression is still a sure reading", () => {
    for (const [text, lang, tz] of [
      ["tomorrow at 3pm", "en", "Australia/Sydney"],
      ["Friday 2pm to 4pm", "en", "Australia/Sydney"],
      ["morgen um 15 Uhr", "de", "Europe/Berlin"],
      ["volgende week vrijdag om 15:00", "nl", "Europe/Amsterdam"],
      ["próximo viernes a las 15:00", "es", "Europe/Madrid"],
      ["nächsten Freitag um 15 Uhr", "de", "Europe/Berlin"],
      ["завтра в 15:00", "ru", "Europe/Moscow"]
    ] as const)
      expect(when(text, tz, SYDNEY_SUN, lang)?.ambiguous, text).toBe(false);
  });

  it("text that is not a date at all stays null, in any language", () => {
    for (const [text, lang] of [
      ["Can you send the report", "en"],
      ["Kannst du den Bericht schicken", "de"],
      ["レポートを送ってください", "ja"]
    ] as const)
      expect(when(text, "UTC", SYDNEY_SUN, lang), text).toBeNull();
  });
});

describe("resolveWhen: review of PR 140", () => {
  const LONDON_REF = "2026-11-08T12:00:00Z";
  it.each(["en-GB", "en-US", "en", "en-AU"])(
    "'Dec 25 at noon' and 'Nov 20 at 3pm' are those days of this year, not a year 2025 or 2020 (%s)",
    (lang) => {
      expect(when("Dec 25 at noon", "Europe/London", LONDON_REF, lang)).toMatchObject({
        candidates: [{ start: "2026-12-25T12:00:00Z" }],
        ambiguous: false
      });
      expect(when("Nov 20 at 3pm", "Europe/London", LONDON_REF, lang)).toMatchObject({
        candidates: [{ start: "2026-11-20T15:00:00Z" }],
        ambiguous: false
      });
      for (const text of ["Dec 25", "December 25th", "25 Dec", "25th December"]) {
        const result = when(text, "Europe/London", LONDON_REF, lang);
        expect(result?.candidates, `${text} ${lang}`).toEqual([
          { start: "2026-12-25T00:00:00Z", end: "2026-12-26T00:00:00Z" }
        ]);
        expect(result?.ambiguous).toBe(true);
      }
    }
  );

  it("a non-ambiguous result that starts before the message, with no past word, is flagged", () => {
    expect(when("today at 9am", "Australia/Sydney", SYDNEY_SUN)?.ambiguous).toBe(true);
    expect(when("today at 9am yesterday", "Australia/Sydney", SYDNEY_SUN)).not.toBeNull();
  });

  it("an ordinal left unread next to a time takes that day: 'due 15th at 5pm' is the 15th, not today", () => {
    expect(when("due 15th at 5pm")).toMatchObject({
      candidates: [{ start: "2026-11-15T17:00:00+11:00" }],
      ambiguous: true
    });
    expect(when("6pm on the 14th")?.candidates[0]?.start).toBe("2026-11-14T18:00:00+11:00");
  });

  it.each(["rent due on the 1st", "on the 5th", "by the 15th"])(
    "an ordinal alone is ambiguous, not null: %s",
    (text) => {
      expect(when(text)?.ambiguous).toBe(true);
    }
  );

  it.each(["Friday 22:00 - 02:00", "Friday 8pm-2am", "Friday from 8pm to 2am"])(
    "an overnight range keeps its end on the next day: %s",
    (text) => {
      const c = when(text)?.candidates[0];
      expect(c?.end, text).toMatch(/^2026-11-14T02:00:00\+11:00$/);
    }
  );

  it("'Saturday at midnight' is the start of Sunday first, ambiguous with both", () => {
    expect(when("Saturday at midnight")?.candidates.map((c) => c.start)).toEqual([
      "2026-11-15T00:00:00+11:00",
      "2026-11-14T00:00:00+11:00"
    ]);
  });

  it("a four-digit year after a month name is still a year", () => {
    expect(when("Dec 2027", "Australia/Sydney", SYDNEY_SUN, "en-GB")?.candidates[0]?.start).toMatch(/^2027-12/);
  });

  it.each(["by the 15th", "on the 3rd", "the 22nd", "by the 1st"])(
    "a bare ordinal day is never a silent null: %s",
    (text) => {
      const result = when(text);
      expect(result).not.toBeNull();
      expect(result?.ambiguous).toBe(true);
      expect(result?.candidates).toHaveLength(1);
    }
  );

  it("a bare ordinal resolves to the next occurrence of that day of the month", () => {
    // 8 Nov 2026 in Sydney: the 15th is this month, the 3rd is next month, the 8th is today.
    expect(when("by the 15th")?.candidates[0]?.start).toBe("2026-11-15T00:00:00+11:00");
    expect(when("on the 3rd")?.candidates[0]?.start).toBe("2026-12-03T00:00:00+11:00");
    expect(when("on the 8th")?.candidates[0]?.start).toBe("2026-11-08T00:00:00+11:00");
    expect(when("by the 31st", "Australia/Sydney", "2026-11-08T01:00:00Z")?.candidates[0]?.start).toBe(
      "2026-12-31T00:00:00+11:00"
    );
    expect(when("by the 15th")?.raw).toEqual([3, 11]);
  });

  it("an overnight range ends the next day", () => {
    expect(when("Friday 10pm to 2am")?.candidates).toEqual([
      { start: "2026-11-13T22:00:00+11:00", end: "2026-11-14T02:00:00+11:00" }
    ]);
    expect(when("tomorrow from 11pm to 1am")?.candidates[0]?.end).toBe("2026-11-10T01:00:00+11:00");
  });

  it("'Friday midnight' means the end of Friday: both readings, the start of Saturday first, ambiguous", () => {
    for (const text of ["Friday midnight", "midnight Friday", "midnight tomorrow"]) {
      const result = when(text);
      expect(result?.ambiguous, text).toBe(true);
      expect(result?.candidates.length, text).toBe(2);
    }
    expect(when("Friday midnight")?.candidates.map((c) => c.start)).toEqual([
      "2026-11-14T00:00:00+11:00",
      "2026-11-13T00:00:00+11:00"
    ]);
    expect(when("midnight tonight")).toMatchObject({
      candidates: [{ start: "2026-11-09T00:00:00+11:00" }],
      ambiguous: false
    });
  });
});
