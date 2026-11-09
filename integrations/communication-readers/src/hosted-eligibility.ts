import { classifyMessage } from "./classify-message.js";
import {
  CONTEXT_MESSAGES,
  newestContext,
  relabel,
  type VettedCandidates,
  type VettedContext
} from "./context-select.js";
import type { LinkCandidate } from "./link-candidates.js";

/** Version of the deny-list below. A change to any pattern or sender token bumps it; it is recorded with each hosted send later. */
export const DENY_LIST_VERSION = "d3";
/** Text longer than this (code points, subject plus body) is never sent: the check reads all of it, and a bound keeps that cheap. */
export const HOSTED_MAX_TEXT_CODE_POINTS = 200000;
/** Context messages put in a prompt: the newest few of the conversation, per the plan. */
export const HOSTED_MAX_CONTEXT = CONTEXT_MESSAGES;

/**
 * Why a message may not go to the hosted tier. Codes only, never the matched text. The first group is about what the
 * text says, the second about who sent it, the third about missing input (on doubt nothing is sent).
 */
export const HOSTED_DENIALS = [
  "one_time_code",
  "banking",
  "password",
  "sensitive_topic",
  "secret",
  "sender_denied",
  "sender_labelled_sensitive",
  "not_person",
  "auth_failed",
  "no_sender",
  "no_text",
  "text_too_long",
  "thread_sensitive"
] as const;
export type HostedDenial = (typeof HOSTED_DENIALS)[number];

/** The reasons that are about content or sender. A context message failing for one of these makes the whole thread sensitive. */
const CONTENT_DENIALS: ReadonlySet<HostedDenial> = new Set([
  "one_time_code",
  "banking",
  "password",
  "sensitive_topic",
  "secret",
  "sender_denied",
  "sender_labelled_sensitive"
]);

export interface HostedMessage {
  /** The gmail row's attrs (`from`, `from_self`, `auth`, `message_id`, ...): classified here by `classifyMessage`. */
  attrs: Record<string, unknown>;
  subject: string | null;
  /** The message text; null when it was removed or never stored. */
  content: string | null;
}

export interface HostedEligibilityInput {
  message: HostedMessage;
  /** The earlier messages of the thread, oldest first. Only the newest 3 (`newestContext`) can be sent, and only those are checked. */
  context: readonly HostedMessage[];
  /** Lower-case sender addresses he has labelled sensitive. */
  /** The link candidates whose quotes would go in the prompt (`linkCandidates`); each quote is checked like message text. */
  candidates?: readonly (LinkCandidate | null | undefined)[] | undefined;
  sensitiveSenders?: ReadonlySet<string> | readonly string[];
}

export interface HostedVerdict {
  eligible: boolean;
  /** Empty when eligible. Codes only. */
  reasons: HostedDenial[];
}

export interface HostedEligibility {
  /** True only when the message itself is eligible and no kept-out context made the thread sensitive. */
  send: boolean;
  message: HostedVerdict;
  /** One verdict per context message the prompt would carry: the newest 3 (`newestContext`), oldest first. */
  context: HostedVerdict[];
  /** Indexes into the input `context` array of the messages that may go in the prompt; empty when `send` is false. */
  contextKept: number[];
  /** One verdict per input candidate, same order (a null entry is not eligible). */
  candidates: HostedVerdict[];
  /** Indexes into the input `candidates` that may go in the prompt; empty when `send` is false. */
  candidatesKept: number[];
  denyListVersion: typeof DENY_LIST_VERSION;
}

// ---- normalisation -------------------------------------------------------------------------------------------------

/** Control characters other than tab and newline, format characters (zero-width, bidi) and the soft hyphen. */
const HIDDEN = /(?:(?![\t\n\r])\p{Cc})|\p{Cf}/gu;
const stripAccents = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");

/** Cyrillic and Greek letters that look like Latin ones, and the usual digit and symbol substitutions. Latin view only. */
const LOOKALIKES: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ѕ: "s",
  ј: "j",
  к: "k",
  м: "m",
  т: "t",
  н: "h",
  в: "b",
  ԁ: "d",
  ԛ: "q",
  ɡ: "g",
  α: "a",
  β: "b",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ϲ: "c",
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  $: "s",
  "@": "a",
  "!": "i"
};
const latinise = (text: string) => text.replace(/[Ͱ-ϿЀ-ӿԀ-ԯɐ-ʯ0134 5$@!]/gu, (c) => LOOKALIKES[c] ?? c);

/** "p a s s w o r d" and "p*a*s*s": a run of single letters one separator apart is one word. */
const collapseSpacedLetters = (text: string) =>
  text.replace(/(?<![\p{L}\p{N}])(?:\p{L}[\s.\-_*]){3,}\p{L}(?![\p{L}\p{N}])/gu, (run) =>
    run.replace(/[\s.\-_*]/gu, "")
  );

/**
 * The texts the patterns run on. Four views: compatibility-folded, lower-cased, accent-stripped text; the same with
 * hidden characters removed instead of replaced by a space ("pass" + zero-width + "word"); and a Latin view of each with
 * look-alike letters and simple leetspeak mapped back. Digit rules run on all of them too, which can only add denials.
 */
function views(text: string): string[] {
  const out = new Set<string>();
  const base = text.normalize("NFKC");
  for (const gap of [" ", ""]) {
    const folded = collapseSpacedLetters(stripAccents(base.replace(HIDDEN, gap).toLowerCase())).replace(
      /[^\S\n]+/gu,
      " "
    );
    out.add(folded);
    out.add(collapseSpacedLetters(latinise(folded)));
  }
  return [...out];
}

// ---- patterns ------------------------------------------------------------------------------------------------------

const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** A word list as one regex over folded text. Latin-script lists need word edges; CJK lists are substrings. */
function words(list: readonly string[], edges = true): RegExp {
  const body = list.map((w) => escapeRe(stripAccents(w.normalize("NFKC").toLowerCase()))).join("|");
  return new RegExp(edges ? `${NOT_WORD_BEFORE}(?:${body})${NOT_WORD_AFTER}` : `(?:${body})`, "u");
}

/** 4 to 8 digits written as one number, in groups ("483 291", "483-291") or digit by digit ("4 8 3 2 9 1"). */
const NUM = "\\d(?:[ -]?\\d){3,7}";
const NOT_A_CODE_KIND =
  "(?<!\\b(?:zip|post|area|country|dialling|dialing|promo|discount|coupon|voucher|colou?r|source|dress|bar|qr|gift|street)\\s)";

const ONE_TIME_CODE: RegExp[] = [
  /\b(?:one[- ]?time|verification|verify|security|authentication|authorisation|authorization|login|log[- ]in|sign[- ]?in|confirmation|confirm|access|activation|reset|recovery|backup|passcode|auth)\s*(?:code|pin|passcode|token|number)\b/u,
  /\b(?:otp|2fa|mfa|totp)\b/u,
  /\b(?:two|2)[- ]?(?:factor|step)\b/u,
  new RegExp(`${NOT_A_CODE_KIND}\\b(?:code|pin|passcode)\\b[^\\d\\n]{0,16}\\b${NUM}\\b`, "u"),
  new RegExp(`\\b${NUM}\\b[^\\n]{0,24}\\b(?:is|as) (?:your|the|a)\\b[^\\n]{0,24}\\b(?:code|pin|passcode|otp)\\b`, "u"),
  new RegExp(
    `\\b(?:use|enter|type|input|submit|quote|provide)\\s+(?:the\\s+|this\\s+|code\\s+|pin\\s+)*${NUM}\\b`,
    "u"
  ),
  new RegExp(`\\b${NUM}\\b\\s+is\\s+(?:the|your)\\s+(?:\\w+\\s+){0,3}(?:code|pin|passcode)\\b`, "u"),
  new RegExp(
    `\\b${NUM}\\b[^\\n]{0,30}\\b(?:to|and) (?:log ?in|sign ?in|verify|confirm|continue|access|authori[sz]e)\\b`,
    "u"
  ),
  /\bg-\d{6}\b/u,
  // Other languages: the term for a code that proves who you are.
  words([
    "code de verification",
    "code de securite",
    "code de confirmation",
    "code a usage unique",
    "mot de passe a usage unique",
    "code d'acces",
    "verifizierungscode",
    "bestatigungscode",
    "sicherheitscode",
    "einmalpasswort",
    "einmalcode",
    "sms-code",
    "bestaetigungscode",
    "tan-nummer",
    "authentifizierungscode",
    "codigo de verificacion",
    "codigo de seguridad",
    "codigo de confirmacion",
    "codigo de acceso",
    "clave de un solo uso",
    "codigo de un solo uso",
    "codice di verifica",
    "codice di sicurezza",
    "codice di conferma",
    "codice monouso",
    "password monouso",
    "codice otp",
    "verificatiecode",
    "beveiligingscode",
    "bevestigingscode",
    "eenmalige code",
    "eenmalig wachtwoord",
    "sms-code",
    "verifieringskod",
    "sakerhetskod",
    "engangskod",
    "bekraftelsekod",
    "engangslosenord",
    "kod weryfikacyjny",
    "codigo de verificacao",
    "codigo de seguranca"
  ]),
  words(
    [
      "код подтверждения",
      "код безопасности",
      "одноразовый код",
      "код верификации",
      "проверочный код",
      "одноразовый пароль",
      "код из смс",
      "код доступа",
      "验证码",
      "驗證碼",
      "校验码",
      "校驗碼",
      "动态密码",
      "動態密碼",
      "安全码",
      "确认码",
      "確認碼",
      "認証コード",
      "確認コード",
      "ワンタイム",
      "セキュリティコード",
      "認証番号",
      "認証用",
      "ワンタイムパスワード"
    ],
    false
  )
];

const BANKING: RegExp[] = [
  /\b(?:bsb|iban|swift|bic|sort code|routing number|account number|acct\.? ?(?:no|number)|a\/c (?:no|number)|acc(?:ount)? no|bank account|bank details|bank statement|bank transfer|wire transfer|direct debit|direct deposit|bpay|payid|pay id|osko|bank login|internet banking|online banking|netbank|credit card|debit card|card number|card details|cvv|cvc|card verification|expiry date|chargeback)\b/u,
  /\b(?:bsb|account|sort code)\b[^\n]{0,12}\b\d{2,3}[- ]?\d{2,3}(?:[- ]?\d{2})?\b/u,
  /\b[a-z]{2}\d{2}(?: ?[a-z0-9]{4}){3,7}(?: ?[a-z0-9]{1,4})?\b/u,
  /\b(?:tax file number|tfn|ssn|social security|national insurance|passport (?:no|number)|driver'?s? licen[cs]e|licen[cs]e (?:no|number|#)|medicare (?:no|number)|member number|date of birth|dob|d\.o\.b|birth ?date)\b/u,
  // Bills and money owed.
  /\b(?:invoices?|amount due|balance due|outstanding balance|overdue|past due|payment due|mortgage|repayments?|loan repayments?|bills? (?:is |are )?(?:due|overdue)|statement of account|credit score)\b/u,
  words([
    "numero de cuenta",
    "numero de compte",
    "kontonummer",
    "cuenta bancaria",
    "compte bancaire",
    "bankkonto",
    "kreditkarte",
    "tarjeta de credito",
    "carte bancaire",
    "factura",
    "facture",
    "rechnung",
    "hypothek",
    "iban",
    "numero di conto",
    "carta di credito",
    "rekeningnummer",
    "creditcard",
    "kontonummer",
    "bankkonto"
  ]),
  words(
    [
      "银行卡",
      "銀行卡",
      "银行账户",
      "信用卡",
      "口座番号",
      "クレジットカード",
      "銀行口座",
      "кредитная карта",
      "номер счета",
      "номер карты",
      "банковский счет"
    ],
    false
  )
];

/** 13 to 19 digits, spaces or hyphens between groups, that pass the Luhn check: a card number. Linear: one scan per run. */
function hasCardNumber(text: string): boolean {
  for (const run of text.match(/\d(?:[ -]?\d){12,18}/gu) ?? []) {
    const digits = run.replace(/[^\d]/gu, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let digit = digits.charCodeAt(i) - 48;
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

const PASSWORD: RegExp[] = [
  /\b(?:password|passphrase|passwd|pwd|credentials|username and password|login details|recovery phrase|seed phrase|mot de passe|contrasena|passwort|kennwort|zugangsdaten|anmeldedaten|identifiants|credenciales|wachtwoord|losenord|senha|nome utente)\b/u,
  /\b(?:pw|pwd|pass|login|log-in|user(?:name)?|uid)\s*[:=]\s*\S/u,
  /\b(?:reset|change|forgot|forgotten|set up|setup|create) (?:your |the |a |my )?(?:password|account|login|pin)\b/u,
  /\b(?:magic|sign[- ]?in|log[- ]?in|login|verification|verify|confirm|activation|reset|recovery) link\b/u,
  /\bverify your (?:e-?mail|account|identity|phone|number)\b/u,
  /\bhttps?:\/\/\S{0,200}(?:reset|token|magic|verify|activate|recover|otp|signin|sign-in|login|auth)\S{0,200}/u,
  words(["пароль", "парол", "密码", "密碼", "パスワード", "暗証番号", "비밀번호"], false)
];

const SENSITIVE_TOPIC: RegExp[] = [
  // health
  /\b(?:diagnos\w{0,6}|medical|medication|prescription|prescribed|pathology|biopsy|oncolog\w*|cancer|chemo\w*|tumou?r|pregnan\w*|miscarriage|fertility|ivf|hiv|std|sti|surgery|surgeon|hospital|clinic|gp appointment|doctor'?s? appointment|doctor appointment|therap(?:y|ist|ies)|psychiatr\w*|psycholog\w*|psych\w*|physio\w*|dr\.? [a-z]+(?:'s)? (?:appointment|visit|rooms?)|(?:got|get|received|waiting for)\b[^.\n]{0,20}\bresults?\b|results? (?:came )?back|psychotherap\w*|counsell?(?:or|ing)|mental health|depress\w*|anxiety|self[- ]harm|suicid\w*|rehab|addiction|(?:test|blood|scan|lab|medical|health|mri|pathology|biopsy) results?|blood test|referral|sick note|medical certificate|disabilit\w*|mri|ct scan|x-?ray|ultrasound|dementia|alzheimer\w*|bipolar|schizophren\w*|antidepress\w*|antipsychotic\w*|adhd|diabet\w*|insulin|epilep\w*|dentist|dental|orthodont\w*|chiropract\w*)\b/u,
  words([
    "therapie",
    "arzttermin",
    "arzt",
    "krankheit",
    "krebs",
    "diagnose",
    "krankenhaus",
    "krankenkasse",
    "zahnarzt",
    "psychiater",
    "medecin",
    "ordonnance",
    "dentiste",
    "medico",
    "dentista",
    "diagnostico",
    "psicologo",
    "psychologue",
    "ziekenhuis",
    "tandarts",
    "sjukhus",
    "lakare",
    "tandlakare",
    "ospedale",
    "dentista"
  ]),
  words(
    [
      "医院",
      "醫院",
      "医生",
      "醫生",
      "诊断",
      "診斷",
      "癌",
      "病院",
      "診断",
      "うつ病",
      "歯医者",
      "врач",
      "больниц",
      "диагноз",
      "психотерап",
      "стоматолог"
    ],
    false
  ),
  // legal and police
  /\b(?:lawyer|solicitor|barrister|attorney|legal advice|legal action|lawsuit|subpoena|summons|court (?:date|order|hearing|case|appearance|summons)|courthouse|in court|to court|magistrate\w*|(?:supreme|district|local|county|federal|family) court|custody|divorce|separation agreement|restraining order|intervention order|protection order|tribunal|police|arrest\w*|bail|criminal|fine notice|infringement|settlement offer|deed poll|will and testament|probate|bankrupt\w*|insolvency|garnishee|family court|parenting order|child support|child maintenance|alimony|spousal support)\b/u,
  words([
    "rechtsanwalt",
    "scheidung",
    "gericht",
    "avocat",
    "abogado",
    "juicio",
    "avvocato",
    "advocaat",
    "scheiding",
    "advokat",
    "skilsmassa"
  ]),
  words(["律师", "律師", "离婚", "離婚", "裁判", "弁護士", "адвокат", "юрист", "развод"], false),
  // work, immigration, welfare, abuse
  /\b(?:fired|job interview|let go|laid off|layoffs?|dismissal|terminated|redundan\w*|disciplinary|grievance|performance review|performance improvement plan|hr (?:said|told|investigation|meeting|complaint)|immigration|visa (?:application|(?:\w+ ){0,2}(?:refused|rejected|denied))|refused entry|citizenship|permanent residen\w*|work permit|green card|asylum|deportation|centrelink|welfare|child protection|domestic violence|domestic abuse|abus(?:e|ed|ive|er)|stalk\w*|coercive|harass\w*|sexual assault|assault\w*|rape|molest\w*|threatened|grief|funeral|bereave\w*)\b/u
];

const SECRET: RegExp[] = [
  /-----begin [a-z ]{0,30}private key-----/u,
  /\b(?:akia|asia)[a-z0-9]{16}\b/u,
  /\b(?:ghp|gho|ghs|ghu|github_pat|xox[abprs]|sk|pk|rk)[-_][a-z0-9_-]{16,}/u,
  /\baiza[a-z0-9_-]{30,}/u,
  /\bnpm_[a-z0-9]{30,}/u,
  /\beyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{5,}/u,
  /\b(?:api[ _-]?key|secret[ _-]?key|access[ _-]?token|bearer)\b[^\n]{0,8}[a-z0-9_.-]{16,}/u
];

// ---- sender --------------------------------------------------------------------------------------------------------

/**
 * Sending domains of banks, payment services, tax and welfare agencies and health booking services. A sender matches
 * when its domain IS one of these or is a subdomain of one (whole dotted suffix), never because a word appears inside a
 * label, so "riverbank.example", "up.example" and "wiseowl.example" do not match. Any `.gov.*` domain also matches.
 */
const SENDER_DOMAINS: readonly string[] = [
  "paypal.com",
  "stripe.com",
  "wise.com",
  "transferwise.com",
  "revolut.com",
  "squareup.com",
  "venmo.com",
  "cash.app",
  "zelle.com",
  "afterpay.com",
  "klarna.com",
  "coinbase.com",
  "binance.com",
  "kraken.com",
  "commbank.com.au",
  "westpac.com.au",
  "anz.com",
  "anz.com.au",
  "nab.com.au",
  "ing.com.au",
  "bendigobank.com.au",
  "suncorp.com.au",
  "ubank.com.au",
  "up.com.au",
  "stgeorge.com.au",
  "bankwest.com.au",
  "banksa.com.au",
  "bankofmelbourne.com.au",
  "macquarie.com.au",
  "macquarie.com",
  "hsbc.com",
  "citi.com",
  "citibank.com",
  "chase.com",
  "wellsfargo.com",
  "bankofamerica.com",
  "barclays.co.uk",
  "lloyds.com",
  "natwest.com",
  "santander.com",
  "visa.com",
  "mastercard.com",
  "americanexpress.com",
  "amex.com",
  "ato.gov.au",
  "my.gov.au",
  "servicesaustralia.gov.au",
  "medicare.gov.au",
  "irs.gov",
  "hmrc.gov.uk",
  "healthengine.com.au",
  "hotdoc.com.au",
  "healthscope.com.au",
  "sonichealthcare.com",
  "chemistwarehouse.com.au"
];
/** Whole labels (dot-separated) that banks and card schemes use as the name of a domain. */
const SENDER_LABELS: ReadonlySet<string> = new Set(["bank", "banking", "netbank", "paypal"]);
const SENDER_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "security",
  "fraud",
  "alerts",
  "otp",
  "2fa",
  "verification",
  "verify",
  "billing",
  "payments"
]);

function senderAddress(from: unknown): string | null {
  if (typeof from !== "string") return null;
  const bracket = /<([^<>]+)>/u.exec(from)?.[1];
  const address = (bracket ?? from).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/u.test(address) ? address : null;
}

function senderDenied(address: string): boolean {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at).replace(/[^a-z0-9]/gu, "");
  const domain = address.slice(at + 1);
  if (SENDER_LOCAL_PARTS.has(local)) return true;
  const labels = domain.split(".");
  if (labels.some((label) => SENDER_LABELS.has(label))) return true;
  if (labels.includes("gov")) return true;
  return SENDER_DOMAINS.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`));
}

// ---- verdict -------------------------------------------------------------------------------------------------------

const anyMatch = (patterns: readonly RegExp[], texts: readonly string[]) =>
  patterns.some((pattern) => texts.some((text) => pattern.test(text)));

/** Which text classes the text falls in. Never returns the match. */
function textDenials(text: string): HostedDenial[] {
  const seen = views(text);
  const out: HostedDenial[] = [];
  if (anyMatch(ONE_TIME_CODE, seen)) out.push("one_time_code");
  if (anyMatch(BANKING, seen) || seen.some(hasCardNumber)) out.push("banking");
  if (anyMatch(PASSWORD, seen)) out.push("password");
  if (anyMatch(SENSITIVE_TOPIC, seen)) out.push("sensitive_topic");
  if (anyMatch(SECRET, seen)) out.push("secret");
  return out;
}

function verdict(message: HostedMessage, sensitive: ReadonlySet<string>): HostedVerdict {
  const reasons: HostedDenial[] = [];
  const attrs = message?.attrs !== null && typeof message?.attrs === "object" ? message.attrs : {};
  const classification = classifyMessage(attrs);
  if (classification.class !== "person") reasons.push("not_person");
  if ((classification.reasons as string[]).includes("auth_failed")) reasons.push("auth_failed");

  const address = senderAddress(attrs.from);
  if (address === null) reasons.push("no_sender");
  else {
    if (senderDenied(address)) reasons.push("sender_denied");
    if (sensitive.has(address)) reasons.push("sender_labelled_sensitive");
  }

  const subject = typeof message?.subject === "string" ? message.subject : "";
  const content = typeof message?.content === "string" ? message.content : "";
  if (content.trim().length === 0) reasons.push("no_text");
  else if (subject.length + content.length > HOSTED_MAX_TEXT_CODE_POINTS) {
    // Length in UTF-16 units over-counts only astral characters, so recount exactly before refusing.
    if (Array.from(subject).length + Array.from(content).length > HOSTED_MAX_TEXT_CODE_POINTS)
      reasons.push("text_too_long");
  }
  if (!reasons.includes("text_too_long")) {
    for (const reason of textDenials(`${subject}\n${content}`)) if (!reasons.includes(reason)) reasons.push(reason);
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Whether a message, and each context message that would go with it, may be sent to the hosted model. The context
 * checked is exactly what `buildFactPrompt` carries: the newest 3 (`newestContext`, the last 3 of the oldest-first
 * array), so no unchecked mail reaches the prompt. An allow rule: every message put in the prompt must be
 * `msg_class: person` with no failed authentication, have a usable sender address, have text, and match no deny-list
 * class (one-time codes, banking, payment and bills, passwords and reset links, health, legal, work and other sensitive
 * topics, keys and tokens, in several languages), nor come from a bank, payment, tax, health or government sender in
 * the versioned list or one he labelled sensitive. Anything missing is a denial: on doubt nothing is sent. A context
 * message that fails is dropped from the prompt, except that one failing for what it says or who sent it also makes the
 * thread sensitive, so the message is not sent either (a bank thread ending "Thanks, done" must not go). The
 * deny-list is reactive: the first mail from a new sensitive sender can pass. Returns reason codes only, never text.
 */
export function hostedEligibility(input: HostedEligibilityInput): HostedEligibility {
  const sensitive = new Set(
    [...(input.sensitiveSenders ?? [])]
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim().toLowerCase())
  );
  const message = verdict(input.message, sensitive);
  const picked = newestContext(input.context);
  const context = picked.map((entry) => verdict(entry.message, sensitive));
  const inputCandidates = Array.isArray(input.candidates) ? input.candidates.slice(0, 5) : [];
  const candidates = inputCandidates.map((entry): HostedVerdict => {
    if (entry === null || typeof entry !== "object") return { eligible: false, reasons: ["no_text"] };
    const quote = typeof entry.quote === "string" ? entry.quote : "";
    if (Array.from(quote).length > HOSTED_MAX_TEXT_CODE_POINTS) return { eligible: false, reasons: ["text_too_long"] };
    const reasons = quote.trim() === "" ? [] : textDenials(quote);
    return { eligible: reasons.length === 0, reasons };
  });
  const threadSensitive =
    context.some((entry) => entry.reasons.some((reason) => CONTENT_DENIALS.has(reason))) ||
    candidates.some((entry) => entry.reasons.some((reason) => CONTENT_DENIALS.has(reason)));
  if (threadSensitive && message.eligible) {
    message.eligible = false;
    message.reasons.push("thread_sensitive");
  }
  const send = message.eligible;
  const candidatesKept = send ? candidates.flatMap((entry, index) => (entry.eligible ? [index] : [])) : [];
  const contextKept = send ? picked.flatMap((entry, index) => (context[index]!.eligible ? [entry.index] : [])) : [];
  const result: HostedEligibility = {
    send,
    message,
    context,
    contextKept,
    candidates,
    candidatesKept,
    denyListVersion: DENY_LIST_VERSION
  };
  vettedMail.set(result, {
    context: contextKept.map((index) => input.context[index] as HostedMessage),
    candidates: candidatesKept.map((index) => inputCandidates[index] as LinkCandidate)
  });
  return result;
}

/** What each eligibility result cleared, kept by identity so a result that was copied or rebuilt clears nothing. */
const vettedMail = new WeakMap<HostedEligibility, { context: HostedMessage[]; candidates: LinkCandidate[] }>();

/**
 * The context messages that may go in the prompt, in order, ready for `buildFactPrompt`: exactly those
 * `hostedEligibility` kept for this result. A result that was copied or built by hand returns nothing.
 */
export function vettedContext<T extends HostedMessage = HostedMessage>(
  eligibility: HostedEligibility
): VettedContext<T> {
  return (vettedMail.get(eligibility)?.context ?? []) as unknown as VettedContext<T>;
}

/** The link candidates that may go in the prompt, relabelled `c1`.. in order; use this same list to read the model's answer. */
export function vettedCandidates(eligibility: HostedEligibility): VettedCandidates<LinkCandidate> {
  return relabel(vettedMail.get(eligibility)?.candidates) as unknown as VettedCandidates<LinkCandidate>;
}
