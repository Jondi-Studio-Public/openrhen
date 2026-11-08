import { describe, expect, it } from "vitest";
import { buildFactPrompt } from "./fact-prompt.js";
import {
  DENY_LIST_VERSION,
  HOSTED_DENIALS,
  hostedEligibility,
  vettedContext,
  type HostedDenial,
  type HostedMessage
} from "./hosted-eligibility.js";

const person = (
  over: Partial<HostedMessage> & { from?: string; attrs?: Record<string, unknown> } = {}
): HostedMessage => ({
  attrs: {
    message_id: "<m1@example.test>",
    in_reply_to: "<m0@example.test>",
    from: over.from ?? "Alex <alex@example.test>",
    from_self: false,
    ...over.attrs
  },
  subject: over.subject ?? "Friday",
  content: over.content ?? "Can you send the report by Friday? Thanks."
});
const reasonsOf = (message: HostedMessage, sensitiveSenders?: string[]) =>
  hostedEligibility({ message, context: [], ...(sensitiveSenders ? { sensitiveSenders } : {}) }).message.reasons;

describe("hostedEligibility: an ordinary personal message goes", () => {
  it("is eligible, with no reasons, and the deny-list version is reported", () => {
    const result = hostedEligibility({ message: person(), context: [] });
    expect(result).toMatchObject({
      send: true,
      message: { eligible: true, reasons: [] },
      contextKept: [],
      denyListVersion: DENY_LIST_VERSION
    });
  });

  it("is not tripped by everyday words", () => {
    for (const content of [
      "Can you book the room for 3pm on Friday? The code review is at 10.",
      "I'll send the quote tomorrow. Sue says the bank holiday is Monday.",
      "Dinner at 7, bring the kids. Parking is on the corner.",
      "Please call me back about the roof repair, my number is 0400 000 000."
    ])
      expect(reasonsOf(person({ content }))).toEqual([]);
  });
});

describe("hostedEligibility: each deny-list class, with synthetic samples", () => {
  const classes: [HostedDenial, string[]][] = [
    [
      "one_time_code",
      [
        "Your verification code is 482913. It expires in 10 minutes.",
        "Use 193847 as your login code.",
        "Security code: 55 22 11",
        "Your one-time passcode is 7741",
        "Enter OTP 998877 to continue",
        "2FA token 123456",
        "V e r i f i c a t i o n   c o d e 123456",
        "Your VERIFICATION CODE is 2 4 6 8 1 0".replace("2 4 6 8 1 0", "246810"),
        "G-482913 is your Google verification code"
      ]
    ],
    [
      "banking",
      [
        "Please pay into BSB 062-000 account 12345678.",
        "My account number is 12345678",
        "IBAN GB82 WEST 1234 5698 7654 32",
        "Card number 4111 1111 1111 1111 expiry 12/29",
        "Here are my credit card details",
        "CVV 123",
        "Can you do a bank transfer today?",
        "wire transfer instructions attached",
        "Tax file number 123 456 782",
        "Mi número de cuenta es 123",
        "A c c o u n t   n u m b e r 99"
      ]
    ],
    [
      "password",
      [
        "The wifi password is hunter2",
        "Here is a link to reset your password: https://example.test/reset/abc",
        "Click the magic link to sign in",
        "Verify your email address",
        "Passphrase: correct horse",
        "Your recovery phrase is below",
        "https://example.test/verify?token=abc123",
        "Das Passwort ist geheim",
        "p a s s w o r d is on the fridge",
        "pass\u200bword is on the fridge"
      ]
    ],
    [
      "sensitive_topic",
      [
        "The biopsy results came back and the oncologist wants to see me.",
        "My solicitor says the custody hearing is on the 14th.",
        "I got my prescription refilled, the GP appointment is Tuesday.",
        "Therapy session moved to Thursday",
        "Mental health day tomorrow",
        "The restraining order was served",
        "Our divorce is final",
        "immigration appointment at 3pm",
        "He's in the hospital after the surgery",
        "Ich habe einen Termin beim Arzt"
      ]
    ],
    [
      "secret",
      [
        "-----BEGIN RSA PRIVATE KEY----- MIIE",
        "key AKIAIOSFODNN7EXAMPLE",
        "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        ["api key: sk", "live", "abcdefghijklmnop1234"].join("_"),
        "Authorization: bearer abcdefghijklmnop12345678"
      ]
    ]
  ];
  for (const [reason, samples] of classes)
    it.each(samples.map((sample) => [sample]))(`${reason}: %s`, (content) => {
      expect(reasonsOf(person({ content }))).toContain(reason);
    });

  it("checks the subject too, with the same rules", () => {
    expect(reasonsOf(person({ subject: "Your one-time code", content: "See below." }))).toContain("one_time_code");
    expect(reasonsOf(person({ subject: "Bank transfer", content: "Thanks, done." }))).toContain("banking");
  });

  it("a number that fails the Luhn check is not a card number", () => {
    expect(reasonsOf(person({ content: "Order reference 4111 1111 1111 1112 is ready for pickup." }))).not.toContain(
      "banking"
    );
  });

  it("never returns the matched text, only codes from the closed list", () => {
    const result = hostedEligibility({
      message: person({ content: "The password is hunter2, code: 482913" }),
      context: []
    });
    expect(JSON.stringify(result)).not.toMatch(/hunter2|482913/);
    for (const reason of result.message.reasons) expect(HOSTED_DENIALS).toContain(reason);
  });
});

describe("hostedEligibility: who sent it", () => {
  it("refuses anything that is not a person-class message, including mail with no headers", () => {
    expect(reasonsOf(person({ attrs: { list_id: "<news.example.test>" } }))).toContain("not_person");
    expect(reasonsOf(person({ attrs: { auto_submitted: "auto-generated" } }))).toContain("not_person");
    expect(reasonsOf({ attrs: { from: "alex@example.test" }, subject: "Hi", content: "Can you call?" })).toContain(
      "not_person"
    );
  });

  it("refuses failed authentication", () => {
    expect(reasonsOf(person({ attrs: { auth: { spf: "fail", dkim: "pass", dmarc: "pass" } } }))).toContain(
      "auth_failed"
    );
    expect(reasonsOf(person({ attrs: { auth: { spf: "pass", dkim: "pass", dmarc: "pass" } } }))).toEqual([]);
  });

  it("refuses a sender in the versioned list of banks, payment, tax, health and legal domains", () => {
    for (const from of [
      "Support <support@paypal.example.test>".replace("example.test", "com"),
      "alerts@mybank-online.com".replace("mybank-online", "bank-online"),
      "no.one@commbank.com.au",
      "dr@hotdoc.com.au",
      "Clerk <clerk@courts.nsw.gov.au>",
      "security@example.test",
      "billing@example.test"
    ])
      expect(reasonsOf(person({ from })), from).toContain("sender_denied");
  });

  it("matches whole domain labels: a name that merely contains a word is not a bank", () => {
    for (const from of [
      "sam@riverbank.example.test",
      "sam@lawn-care.example.test",
      "sam@singing.example.test",
      "sam@example.test"
    ])
      expect(reasonsOf(person({ from })), from).toEqual([]);
  });

  it("refuses a sender he labelled sensitive, ignoring case and the display name", () => {
    expect(reasonsOf(person({ from: "Pat <Pat@Example.test>" }), ["pat@example.test"])).toContain(
      "sender_labelled_sensitive"
    );
    expect(reasonsOf(person({ from: "Pat <pat@example.test>" }), ["someone@else.test"])).toEqual([]);
  });

  it("refuses when there is no usable sender address", () => {
    for (const from of ["", "Alex", "Alex <not an address>"])
      expect(reasonsOf(person({ from }))).toContain("no_sender");
  });
});

describe("hostedEligibility: on doubt, nothing is sent", () => {
  it("refuses removed text, and text over the cap", () => {
    expect(reasonsOf(person({ content: "" }))).toContain("no_text");
    expect(reasonsOf({ ...person(), content: null })).toContain("no_text");
    expect(reasonsOf(person({ content: "ok ".repeat(100001) }))).toContain("text_too_long");
  });

  it("does not throw on bad input and refuses it", () => {
    const bad = { attrs: null, subject: 5, content: {} } as unknown as HostedMessage;
    const result = hostedEligibility({ message: bad, context: [bad] });
    expect(result.send).toBe(false);
  });
});

describe("hostedEligibility: context messages are checked too (review S5)", () => {
  const bankThread = person({ content: "Please confirm the bank transfer. My account number is 12345678." });
  const ok = person({ content: "Sounds good, see you then." });

  it("a bank thread ending 'Thanks, done' does not go: the thread is sensitive", () => {
    const result = hostedEligibility({ message: person({ content: "Thanks, done." }), context: [bankThread, ok] });
    expect(result.send).toBe(false);
    expect(result.message.reasons).toEqual(["thread_sensitive"]);
    expect(result.context[0]).toMatchObject({ eligible: false });
    expect(result.contextKept).toEqual([]);
  });

  it("a context message that fails only structurally (a newsletter in the thread) is dropped, and the rest go", () => {
    const newsletter = person({ attrs: { list_id: "<l.example.test>" } });
    const result = hostedEligibility({ message: person(), context: [ok, newsletter, ok] });
    expect(result.send).toBe(true);
    expect(result.context.map((c) => c.eligible)).toEqual([true, false, true]);
    expect(result.contextKept).toEqual([0, 2]);
  });

  it("a message that fails itself sends nothing, whatever the context", () => {
    const result = hostedEligibility({ message: person({ content: "Your OTP is 123456" }), context: [ok] });
    expect(result).toMatchObject({ send: false, contextKept: [] });
  });

  it("a sensitive sender label applies to context senders as well", () => {
    const result = hostedEligibility({
      message: person(),
      context: [person({ from: "Pat <pat@example.test>" })],
      sensitiveSenders: ["pat@example.test"]
    });
    expect(result.send).toBe(false);
  });
});

describe("hostedEligibility: cost", () => {
  it("scans a 200,000-character message quickly, including adversarial repeats", () => {
    const began = performance.now();
    for (const content of [
      "a".repeat(199000),
      "pass ".repeat(39000),
      "1 ".repeat(99000),
      "https://x/" + "a".repeat(190000),
      "9".repeat(199000)
    ])
      hostedEligibility({ message: person({ content }), context: [] });
    expect(performance.now() - began).toBeLessThan(5000);
  });
});

describe("hostedEligibility: the context checked is the context sent (verifier blocking 1)", () => {
  const ok = (n: number) => person({ subject: `s${n}`, content: `Plain message number ${n}, see you soon.` });
  const secret = (n: number) => person({ subject: `s${n}`, content: `Message ${n}: the wifi password is hunter2` });

  it("checks the newest 3 of 5: a password in the 4th and 5th is seen, and the thread is sensitive", () => {
    const context = [ok(1), ok(2), ok(3), secret(4), secret(5)];
    const result = hostedEligibility({ message: person(), context });
    expect(result.context).toHaveLength(3);
    expect(result.context.map((c) => c.eligible)).toEqual([true, false, false]);
    expect(result.send).toBe(false);
    expect(result.contextKept).toEqual([]);
  });

  it("reports kept indexes in the input array, and vettedContext returns exactly those messages", () => {
    const context = [secret(1), ok(2), ok(3), person({ attrs: { list_id: "<l.example.test>" } }), ok(5)];
    const result = hostedEligibility({ message: person(), context });
    expect(result.send).toBe(true);
    expect(result.contextKept).toEqual([2, 4]);
    expect(vettedContext(result, context)).toEqual([context[2], context[4]]);
  });

  it("a prompt built from the vetted context never contains a message the check did not pass", () => {
    const context = [ok(1), ok(2), ok(3), secret(4), secret(5)];
    const result = hostedEligibility({ message: person(), context: context.slice(0, 3) });
    const sent = vettedContext(result, context.slice(0, 3));
    const prompt = buildFactPrompt({
      boundary: "k3j9x0aab7q2m5zr",
      message: { from: "a@example.test", subject: "s", content: "Hello there" },
      context: sent.map((m) => ({ subject: m.subject, content: m.content ?? "", fromSelf: false })) as never
    });
    expect(prompt.ok && prompt.user).toBeTruthy();
    // Direct use of the whole thread is refused at the type level; at run time the bad mail only gets in via the cast above.
    const all = hostedEligibility({ message: person(), context });
    expect(all.send).toBe(false);
  });

  it("holes in the context array are skipped, not thrown on", () => {
    const result = hostedEligibility({ message: person(), context: [null, ok(2), undefined] as never });
    expect(result.send).toBe(true);
    expect(result.contextKept).toEqual([1]);
  });
});

describe("hostedEligibility: wider deny-list (verifier 4 to 6)", () => {
  const denied: [HostedDenial, string][] = [
    ["one_time_code", "Use 483291 to log in"],
    ["one_time_code", "483291 is the code for your account"],
    ["one_time_code", "Please enter 483291"],
    ["one_time_code", "code 483 291"],
    ["one_time_code", "your code: 4 8 3 2 9 1"],
    ["one_time_code", "Use code 483-291 to sign in"],
    ["one_time_code", "Votre code de vérification est 123456"],
    ["one_time_code", "Ihr Bestätigungscode lautet 123456"],
    ["one_time_code", "Tu código de verificación es 123456"],
    ["one_time_code", "Il tuo codice di verifica è 123456"],
    ["one_time_code", "Uw verificatiecode is 123456"],
    ["one_time_code", "Ваш код подтверждения 123456"],
    ["one_time_code", "您的验证码是 123456"],
    ["one_time_code", "認証コードは 123456 です"],
    ["one_time_code", "Din verifieringskod är 123456"],
    ["password", "пароль: abc"],
    ["password", "你的密码是 abc"],
    ["password", "パスワードは abc です"],
    ["password", "Die Zugangsdaten stehen unten"],
    ["password", "pw: swordfish"],
    ["password", "login: sam"],
    ["password", "Pаssword is on the fridge"],
    ["password", "p4ssw0rd is on the fridge"],
    ["password", "pa$$word is on the fridge"],
    ["password", "Ρassword is on the fridge"],
    ["banking", "The invoice is attached, amount due Friday"],
    ["banking", "Your bill is overdue"],
    ["banking", "mortgage repayments went up"],
    ["banking", "sort code 20-00-00 account 12345678"],
    ["banking", "Date of birth 01/02/1990"],
    ["banking", "driver's licence 12345678"],
    ["banking", "Rechnung im Anhang"],
    ["sensitive_topic", "I had an MRI yesterday"],
    ["sensitive_topic", "He has dementia now"],
    ["sensitive_topic", "She is bipolar and on antidepressants"],
    ["sensitive_topic", "Therapie am Montag"],
    ["sensitive_topic", "Arzttermin um 3"],
    ["sensitive_topic", "I was fired on Friday"],
    ["sensitive_topic", "HR said they will let me go"],
    ["sensitive_topic", "He keeps stalking her"],
    ["sensitive_topic", "My visa was refused"],
    ["sensitive_topic", "child support is late"],
    ["sensitive_topic", "dentist at 3pm Thursday"],
    ["secret", ["key AIza", "Sy", "A1234567890abcdefghijklmnopqrstuv"].join("")],
    ["secret", "npm_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["secret", "sk-abcdefghijklmnopqrstuvwx"],
    ["secret", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghij"].join(".")]
  ];
  it.each(denied)("%s: %s", (reason, content) => {
    expect(reasonsOf(person({ content }))).toContain(reason);
  });

  it("catches evasions where hidden characters are removed, not replaced by a space", () => {
    for (const content of [
      "pass\u200bword is on the fridge",
      "ver\u2060ification co\u200bde 123456",
      "ac\u200bcount num\u200bber 12"
    ])
      expect(reasonsOf(person({ content })), content).not.toEqual([]);
  });

  it("does not match across words: 'compass code', 'scorecard number', 'zip code 90210'", () => {
    for (const content of [
      "The compass code review is Friday",
      "Please send the scorecard number of runs",
      "Zip code 90210 is the delivery area",
      "postcode 2000"
    ])
      expect(reasonsOf(person({ content })), content).toEqual([]);
  });

  it("does not deny a sender because a word is inside a label", () => {
    for (const from of [
      "a@up.example.test",
      "a@law.example.test",
      "a@health.example.test",
      "a@zip.example.test",
      "a@square.example.test",
      "a@wise.example.test",
      "a@wiseowl.example.test",
      "a@my-bank-club.example.test"
    ])
      expect(reasonsOf(person({ from })), from).toEqual([]);
  });

  it("does deny the curated senders and government domains", () => {
    for (const from of [
      "a@wise.com",
      "a@mail.wise.com",
      "a@up.com.au",
      "a@my.gov.au",
      "a@service.nsw.gov.au",
      "a@bank.example.test",
      "a@e.paypal.example.test"
    ])
      expect(reasonsOf(person({ from })), from).toContain("sender_denied");
  });

  it("keeps the false-positive rate low: at most 10% of 30 ordinary synthetic mails are denied", () => {
    const ordinary = [
      "Hi Sam, are you free Thursday at 7 for dinner? We booked the corner table.",
      "Reminder: school photo day is next Wednesday. Wear the uniform please.",
      "Can you pick up the kids at 3:30 on Friday? I have a meeting.",
      "Tennis is on at 6 on Sunday, court 4. Bring balls.",
      "Let's catch up for a call on Monday morning, 10 works for me.",
      "I'll send the slides by Friday and you can review them over the weekend.",
      "Shopping list: milk, eggs, bread, bananas, the good coffee.",
      "Birthday party for Mia on the 22nd at our place, 2pm. Please bring a plate.",
      "Can you confirm the meeting room for Tuesday at 11? Ten people.",
      "The plumber is coming Wednesday between 8 and 12.",
      "Thanks for the photos! The beach one is my favourite.",
      "Your flight lands at 6:40pm, I'll be at arrivals.",
      "Could you review my draft by Thursday? Two pages only.",
      "We're having a barbecue on Saturday, bring a drink if you like.",
      "Parent-teacher interviews are on the 14th, I booked 4:15 for us.",
      "The team lunch is at noon tomorrow at the Italian place.",
      "Don't forget to RSVP for the wedding by the end of the month.",
      "I'll call you after the football on Sunday.",
      "Can we move the standup to 9:30 tomorrow? Sam has a clash.",
      "Dad's birthday dinner is Friday at 7. I'll book a table for six.",
      "Please send me the updated roster before the weekend.",
      "The car is booked in for a service on Monday at 8am.",
      "Rain forecast for Saturday so the picnic moves to Sunday.",
      "Quick one: can you bring the ladder over this weekend?",
      "Book club is Thursday at 7:30 at Jo's, we're reading the new Rooney.",
      "Remember to bring the signed form to school on Monday.",
      "I'm free for coffee Tuesday or Wednesday afternoon, your pick.",
      "Movie night Friday? There's a new one at the Palace at 8.",
      "Can you water the plants while we're away from the 3rd to the 10th?",
      "Thanks, see you at the park at 10, I'll bring the frisbee."
    ];
    expect(ordinary).toHaveLength(30);
    const denied = ordinary.filter((content) => !hostedEligibility({ message: person({ content }), context: [] }).send);
    expect(denied.length, denied.join(" | ")).toBeLessThanOrEqual(3);
  });
});
