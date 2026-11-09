import type { ReplayCase, ReplayGold, ReplayInput } from "./replay-case.js";

/**
 * Seeded synthetic cases for the replay harness: committed code, no data. A plan is built from a
 * fixed fake vocabulary (every word is in `test/replay/lexicon.json`, every address is at
 * `example.test`), then each message is derived from a plan record by one controlled mutation, so
 * the gold comes from the mutation and nothing is labelled by hand. The same seed gives the same
 * cases on every machine; plans and messages draw from separate streams, so asking for more cases
 * does not change the plan or the cases before them.
 *
 * Plan sizes are multiples of the 1x plan (about 411 records, the shape of a real one): `5x` and
 * `20x` stress matching cost and candidate crowding, not new kinds of case.
 */

export const PLAN_SIZES = { "1x": 1, "5x": 5, "20x": 20 } as const;
export type PlanSize = keyof typeof PLAN_SIZES;
export const SIZE_NAMES = Object.keys(PLAN_SIZES) as PlanSize[];

export const DEFAULT_SEED = "replay-gen-v1";

export const NOUNS = [
  "banner",
  "basement",
  "bicycle",
  "binder",
  "boiler",
  "brochure",
  "cabinet",
  "calendar",
  "canvas",
  "carpet",
  "catalogue",
  "ceiling",
  "chimney",
  "cupboard",
  "curtain",
  "dashboard",
  "deposit",
  "diagram",
  "drawer",
  "elevator",
  "envelope",
  "fence",
  "festival",
  "filter",
  "folder",
  "fountain",
  "furnace",
  "garage",
  "garden",
  "gutter",
  "handbook",
  "heater",
  "inventory",
  "invoice",
  "kettle",
  "kitchen",
  "ladder",
  "laptop",
  "ledger",
  "locker",
  "mailbox",
  "manual",
  "mattress",
  "microscope",
  "newsletter",
  "orchard",
  "pantry",
  "passport",
  "pavement",
  "pipeline",
  "playground",
  "poster",
  "printer",
  "projector",
  "pump",
  "recipe",
  "receipt",
  "roster",
  "router",
  "scaffold",
  "shelf",
  "shutter",
  "stopwatch",
  "speaker",
  "stairwell",
  "survey",
  "tablet",
  "tenancy",
  "thermostat",
  "timetable",
  "toolbox",
  "trellis",
  "ventilator",
  "voucher",
  "wardrobe",
  "warranty",
  "window",
  "workbench",
  "yearbook",
  "zipper"
] as const;

export const VERBS = [
  "archive",
  "assemble",
  "book",
  "calibrate",
  "collect",
  "compare",
  "deliver",
  "download",
  "draft",
  "fetch",
  "inspect",
  "install",
  "label",
  "measure",
  "order",
  "organise",
  "outline",
  "pack",
  "pay",
  "polish",
  "prepare",
  "print",
  "proofread",
  "publish",
  "record",
  "register",
  "rehearse",
  "renew",
  "repair",
  "scan",
  "schedule",
  "sign",
  "sort",
  "submit",
  "summarise",
  "test",
  "tidy",
  "track",
  "update",
  "upload"
] as const;

/** Forty fictional contacts: a first name, the surname "Example", and an address at example.test. */
export const FIRST_NAMES = [
  "alex",
  "sam",
  "avery",
  "blake",
  "casey",
  "dana",
  "drew",
  "ellis",
  "emery",
  "finley",
  "gale",
  "harper",
  "indigo",
  "jordan",
  "kendall",
  "lane",
  "logan",
  "marlow",
  "morgan",
  "nico",
  "oakley",
  "parker",
  "quinn",
  "reese",
  "riley",
  "robin",
  "rowan",
  "sage",
  "shay",
  "sidney",
  "skyler",
  "tatum",
  "taylor",
  "teddy",
  "val",
  "winter",
  "wren",
  "yael",
  "zion",
  "pat"
] as const;

/** Every word the generator can put in a title, quote or name; the privacy guard checks it against the lexicon. */
export const GENERATOR_WORDS: readonly string[] = [
  ...NOUNS,
  ...VERBS,
  ...FIRST_NAMES,
  "example",
  "confirming",
  "the",
  "please",
  "reminder",
  "due",
  "moved",
  "cancelled",
  "review"
];

export const NOW = "2026-11-09T09:00:00Z";
const TIMEZONE = "UTC";
const DAY = 86_400_000;
const FIRST_DAY = Date.UTC(2026, 10, 10);
const HORIZON_DAYS = 120;

/** FNV-1a: turns a seed string into a 32-bit state. */
function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** mulberry32: small, fast and identical everywhere. */
export function createRng(seed: string): () => number {
  let a = hashOf(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (rng: Rng, n: number) => Math.floor(rng() * n);
const pick = <T>(rng: Rng, items: readonly T[]): T => items[int(rng, items.length)]!;
const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

const dateOf = (dayOffset: number) => new Date(FIRST_DAY + dayOffset * DAY).toISOString().slice(0, 10);
const instant = (day: string, hour: number) => `${day}T${String(hour).padStart(2, "0")}:00:00Z`;

type Plan = ReplayInput["plan"];
type Commitment = Plan["commitments"][number];
type Action = Plan["actions"][number];
type Project = Plan["projects"][number];
type Contact = Plan["contacts"][number];
type OpenFact = Plan["openFacts"][number];

/** What the plan holds, grouped by the property a mutation needs, so a message can find its source. */
interface Pools {
  plain: Commitment[];
  twinPairs: Array<[Commitment, Commitment]>;
  neighbourPairs: Array<[Commitment, Commitment]>;
  /** Twins told apart by contact: `[first, second, the contact who owns the second]`. */
  contactTwins: Array<[Commitment, Commitment, Contact]>;
  aliased: Array<{ commitment: Commitment; remote: string }>;
  actions: Action[];
  actionTwins: Array<[Action, Action]>;
  numbered: Array<{ low: Action; high: Action; prefix: boolean }>;
  /** An action with no number in its title and no other of that title, so a deadline a week from it is a new one. */
  deadlineNeighbours: Action[];
  projects: Project[];
  asks: OpenFact[];
  askTwins: Array<[OpenFact, OpenFact]>;
  askUids: OpenFact[];
}

export interface GeneratedPlan {
  plan: Plan;
  pools: Pools;
  /** Fresh, unused titles for messages that name something not on the plan. */
  freshTitle: (rng: Rng) => string;
  /** A title for a new ask: it shares no word with any open ask, so the lexical matcher has nothing to trip on. */
  freshAskTitle: (rng: Rng) => string;
}

/** Per 1x plan: how many of each record shape. The totals come to about 411 records. */
export const SHAPE_COUNTS = {
  plain: 250,
  twinPairs: 4,
  neighbourPairs: 4,
  contactTwins: 3,
  aliased: 5,
  actions: 40,
  actionTwins: 3,
  numbered: 6,
  projects: 12,
  contacts: 40,
  asks: 20,
  askTwins: 3,
  askUids: 5,
  deadlineNeighbours: 3
} as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** A plan of the given size. Deterministic in `(seed, size)`. */
export function generatePlan(seed: string, size: PlanSize): GeneratedPlan {
  const m = PLAN_SIZES[size];
  const rng = createRng(`${seed}:plan:${size}`);
  const used = new Set<string>();
  const title = (r: Rng): string => {
    for (;;) {
      const words = [pick(r, VERBS), pick(r, NOUNS), pick(r, NOUNS)];
      const text = words.join(" ");
      if (words[1] === words[2] || used.has(text)) continue;
      used.add(text);
      return cap(text);
    }
  };

  const contacts: Contact[] = FIRST_NAMES.slice(0, SHAPE_COUNTS.contacts).map((first, i) => ({
    id: `k${i + 1}`,
    name: `${cap(first)} Example`,
    email: `${first}@example.test`
  }));

  let commitmentSeq = 0;
  const commitments: Commitment[] = [];
  const addCommitment = (text: string, day: number, hour: number, contactId: string | null = null): Commitment => {
    const c: Commitment = {
      id: `c${++commitmentSeq}`,
      title: text,
      startsAt: instant(dateOf(day), hour),
      endsAt: instant(dateOf(day), hour + 1),
      allDay: false,
      status: "scheduled",
      contactId
    };
    commitments.push(c);
    return c;
  };
  const slot = () => ({ day: 1 + int(rng, HORIZON_DAYS - 8), hour: 8 + int(rng, 9) });

  const pools: Pools = {
    plain: [],
    twinPairs: [],
    neighbourPairs: [],
    contactTwins: [],
    aliased: [],
    actions: [],
    actionTwins: [],
    numbered: [],
    projects: [],
    asks: [],
    askTwins: [],
    askUids: [],
    deadlineNeighbours: []
  };
  const aliases: Plan["aliases"] = [];

  for (let i = 0; i < SHAPE_COUNTS.plain * m; i++) {
    const { day, hour } = slot();
    pools.plain.push(addCommitment(title(rng), day, hour));
  }
  for (let i = 0; i < SHAPE_COUNTS.twinPairs * m; i++) {
    const { day, hour } = slot();
    const text = title(rng);
    pools.twinPairs.push([addCommitment(text, day, hour), addCommitment(text, day, hour)]);
  }
  for (let i = 0; i < SHAPE_COUNTS.neighbourPairs * m; i++) {
    const { day, hour } = slot();
    const text = title(rng);
    pools.neighbourPairs.push([addCommitment(text, day, hour), addCommitment(text, day + 7, hour)]);
  }
  for (let i = 0; i < SHAPE_COUNTS.contactTwins * m; i++) {
    const { day, hour } = slot();
    const text = title(rng);
    const [a, b] = [contacts[int(rng, contacts.length)]!, contacts[int(rng, contacts.length)]!];
    const other = a.id === b.id ? contacts[(contacts.indexOf(b) + 1) % contacts.length]! : b;
    pools.contactTwins.push([addCommitment(text, day, hour, a.id), addCommitment(text, day, hour, other.id), other]);
  }
  for (let i = 0; i < SHAPE_COUNTS.aliased * m; i++) {
    const commitment = pools.plain[i]!;
    const remote = title(rng);
    aliases.push({ remoteTitleNorm: remote.toLowerCase(), localTitleNorm: commitment.title.toLowerCase() });
    pools.aliased.push({ commitment, remote });
  }

  let actionSeq = 0;
  const actions: Action[] = [];
  const addAction = (text: string, day: number): Action => {
    const a: Action = { id: `a${++actionSeq}`, title: text, deadlineAt: dateOf(day), status: "open" };
    actions.push(a);
    return a;
  };
  const deadlineDay = () => 5 + int(rng, HORIZON_DAYS - 30);
  for (let i = 0; i < SHAPE_COUNTS.actions * m; i++) pools.actions.push(addAction(title(rng), deadlineDay()));
  for (let i = 0; i < SHAPE_COUNTS.actionTwins * m; i++) {
    const day = deadlineDay();
    const text = title(rng);
    pools.actionTwins.push([addAction(text, day), addAction(text, day)]);
  }
  for (let i = 0; i < SHAPE_COUNTS.numbered * m; i++) {
    const day = deadlineDay();
    const base = title(rng);
    const prefix = i % 2 === 1;
    pools.numbered.push({
      low: addAction(`${base} 1`, day),
      high: addAction(`${base} ${prefix ? 12 : 2}`, day),
      prefix
    });
  }

  const projects: Project[] = [];
  for (let i = 0; i < SHAPE_COUNTS.projects * m; i++) {
    const p: Project = { id: `p${i + 1}`, title: title(rng), deadlineAt: dateOf(deadlineDay()), status: "open" };
    projects.push(p);
    pools.projects.push(p);
  }

  let factSeq = 0;
  const openFacts: OpenFact[] = [];
  const addFact = (text: string, conversationKey: string, icsUid: string | null = null): OpenFact => {
    const f: OpenFact = { id: `f${++factSeq}`, title: text, conversationKey, icsUid };
    openFacts.push(f);
    return f;
  };
  // Open asks draw on the first half of the vocabulary and fresh asks on the second.
  const half = (items: readonly string[], second: boolean) =>
    second ? items.slice(items.length / 2) : items.slice(0, items.length / 2);
  const askTitle = (): string => {
    const [verb, noun] = [pick(rng, half(VERBS, false)), pick(rng, half(NOUNS, false))];
    const text = `${verb} the ${noun}`;
    if (used.has(text)) return askTitle();
    used.add(text);
    return cap(text);
  };
  for (let i = 0; i < SHAPE_COUNTS.asks * m; i++) pools.asks.push(addFact(askTitle(), `conv-a${i + 1}`));
  for (let i = 0; i < SHAPE_COUNTS.askTwins * m; i++) {
    const text = askTitle();
    pools.askTwins.push([addFact(text, `conv-t${i + 1}a`), addFact(text, `conv-t${i + 1}b`)]);
  }
  for (let i = 0; i < SHAPE_COUNTS.askUids * m; i++) {
    pools.askUids.push(addFact(askTitle(), `conv-u${i + 1}`, `uid-${i + 1}@example.test`));
  }

  // Last, so the draws above (and every plan before this shape existed) are unchanged.
  for (let i = 0; i < SHAPE_COUNTS.deadlineNeighbours * m; i++) {
    pools.deadlineNeighbours.push(addAction(title(rng), deadlineDay()));
  }

  const plan: Plan = deepFreeze({ commitments, actions, projects, contacts, aliases, openFacts });
  const freshAskTitle = (r: Rng) =>
    cap([pick(r, half(VERBS, true)), pick(r, half(NOUNS, true)), pick(r, half(NOUNS, true))].join(" "));
  return { plan, pools, freshTitle: title, freshAskTitle };
}

export const KINDS = [
  "restated",
  "reworded",
  "moved",
  "cancel",
  "cancel-unknown",
  "cancel-lookalike",
  "new",
  "past",
  "no-facts",
  "no-start-time",
  "alias",
  "twin",
  "twin-contact",
  "neighbour",
  "deadline-same",
  "deadline-project",
  "deadline-moved",
  "deadline-new",
  "numbered",
  "deadline-twin",
  "ask-same-thread",
  "ask-new",
  "ask-uid",
  "ask-same-thread-new",
  "ask-twin",
  "deadline-neighbour"
] as const;
export type Kind = (typeof KINDS)[number];

/** Tags a kind carries besides its own name, from the harness's tag list. */
const KIND_TAGS: Partial<Record<Kind, string[]>> = {
  reworded: ["reminder-of-confirmation"],
  moved: ["reschedule"],
  cancel: ["cancel"],
  "cancel-unknown": ["cancel", "no-plan-effect"],
  "cancel-lookalike": ["cancel"],
  past: ["no-plan-effect"],
  "no-facts": ["no-plan-effect"],
  twin: ["tie-twins"],
  "twin-contact": ["sender-contact", "tie-twins"],
  neighbour: ["recurring-neighbour"],
  "deadline-moved": ["moved-deadline"],
  numbered: ["numbered-sibling"],
  "deadline-twin": ["tie-twins"],
  "ask-new": ["ask-no-date"],
  "ask-uid": ["ask-no-date"],
  "ask-same-thread-new": ["ask-no-date"],
  "ask-twin": ["ask-no-date", "tie-twins"]
};

const commitmentTarget = (c: { id: string }) => ({ kind: "commitment" as const, id: c.id });

interface Draft {
  from?: string;
  fact?: ReplayInput["message"]["facts"][number];
  gold: ReplayGold;
}

type Fact = NonNullable<Draft["fact"]>;

function eventFact(quote: string, c: Commitment, extra: Partial<Fact> = {}): Fact {
  return { type: "event", quote, conversationKey: "conv-1", cancelled: false, when: [c.startsAt, c.endsAt!], ...extra };
}

function deadlineFact(quote: string, date: string): Fact {
  return { type: "deadline", quote, conversationKey: "conv-1", cancelled: false, when: [date] };
}

function askFact(quote: string, conversationKey: string, icsUid?: string): Fact {
  return { type: "ask", quote, conversationKey, cancelled: false, ...(icsUid ? { icsUid } : {}) };
}

const lower = (text: string) => text.toLowerCase();
const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);

function draft(kind: Kind, built: GeneratedPlan, rng: Rng): Draft {
  const { pools } = built;
  switch (kind) {
    case "restated": {
      const c = pick(rng, pools.plain);
      return { fact: eventFact(c.title, c), gold: { endState: "duplicate", target: commitmentTarget(c) } };
    }
    case "reworded": {
      const c = pick(rng, pools.plain);
      return {
        fact: eventFact(`Confirming the ${lower(c.title)}`, c),
        gold: { endState: "duplicate", target: commitmentTarget(c) }
      };
    }
    case "moved": {
      // Moved to the evening after, when the generated plan holds nothing, so the move is the only signal.
      const c = pick(rng, pools.plain);
      const day = addDays(c.startsAt.slice(0, 10), 1);
      const fact = eventFact(`${c.title} moved`, c, { when: [instant(day, 19), instant(day, 20)] });
      return {
        fact,
        gold: { endState: "applied", op: "update", target: commitmentTarget(c), mustNot: ["create"] }
      };
    }
    case "cancel": {
      const c = pick(rng, pools.plain);
      return {
        fact: eventFact(`${c.title} cancelled`, c, { cancelled: true }),
        gold: { endState: "applied", op: "cancel", target: commitmentTarget(c) }
      };
    }
    case "cancel-unknown": {
      const c = pick(rng, pools.plain);
      return {
        // An evening slot, where the generated plan holds nothing, so only the name could match.
        fact: eventFact(`${built.freshTitle(rng)} cancelled`, c, {
          cancelled: true,
          when: [instant(c.startsAt.slice(0, 10), 21), instant(c.startsAt.slice(0, 10), 22)]
        }),
        gold: { endState: "no_effect", reason: "nothing_to_cancel" }
      };
    }
    case "cancel-lookalike": {
      const c = pick(rng, pools.plain);
      return {
        fact: eventFact(`${c.title} review cancelled`, c, { cancelled: true }),
        gold: { endState: "no_effect", reason: "nothing_to_cancel", deny: true, mustNot: ["apply"] }
      };
    }
    case "new": {
      const day = dateOf(1 + int(rng, HORIZON_DAYS - 8));
      const fact: Fact = {
        type: "event",
        quote: built.freshTitle(rng),
        conversationKey: "conv-1",
        cancelled: false,
        when: [instant(day, 21), instant(day, 22)]
      };
      return { fact, gold: { endState: "applied", op: "create" } };
    }
    case "past": {
      const day = dateOf(-5 - int(rng, 20));
      const fact: Fact = {
        type: "event",
        quote: built.freshTitle(rng),
        conversationKey: "conv-1",
        cancelled: false,
        when: [instant(day, 10), instant(day, 11)]
      };
      return { fact, gold: { endState: "no_effect", reason: "past" } };
    }
    case "no-facts":
      return { gold: { endState: "no_effect", reason: "no_facts" } };
    case "no-start-time": {
      const c = pick(rng, pools.plain);
      const fact: Fact = { type: "event", quote: `${c.title} moved`, conversationKey: "conv-1", cancelled: false };
      return { fact, gold: { endState: "unresolved", reason: "no_start_time" } };
    }
    case "alias": {
      const { commitment, remote } = pick(rng, pools.aliased);
      return {
        fact: eventFact(remote, commitment),
        gold: { endState: "duplicate", target: commitmentTarget(commitment) }
      };
    }
    case "twin": {
      const [a] = pick(rng, pools.twinPairs);
      return { fact: eventFact(a.title, a), gold: { endState: "asked", mustNot: ["apply"] } };
    }
    case "twin-contact": {
      // The second twin belongs to the sender, so the sender tells them apart.
      const [a, b, owner] = pick(rng, pools.contactTwins);
      return {
        from: owner.email!,
        fact: eventFact(a.title, a),
        gold: { endState: "duplicate", target: commitmentTarget(b) }
      };
    }
    case "neighbour": {
      const [, later] = pick(rng, pools.neighbourPairs);
      return { fact: eventFact(later.title, later), gold: { endState: "duplicate", target: commitmentTarget(later) } };
    }
    case "deadline-same": {
      const a = pick(rng, pools.actions);
      return {
        fact: deadlineFact(`Reminder ${lower(a.title)} due`, a.deadlineAt!),
        gold: { endState: "duplicate", target: { kind: "action", id: a.id } }
      };
    }
    case "deadline-project": {
      const p = pick(rng, pools.projects);
      return {
        fact: deadlineFact(`${p.title} due`, p.deadlineAt!),
        gold: { endState: "duplicate", target: { kind: "project", id: p.id } }
      };
    }
    case "deadline-moved": {
      const a = pick(rng, pools.actions);
      const days = pick(rng, [3, 20]);
      return {
        fact: deadlineFact(`${a.title} due moved`, addDays(a.deadlineAt!, days)),
        gold: { endState: "applied", op: "update", target: { kind: "action", id: a.id }, mustNot: ["create"] }
      };
    }
    case "deadline-new":
      return {
        fact: deadlineFact(`${built.freshTitle(rng)} due`, dateOf(5 + int(rng, HORIZON_DAYS - 30))),
        gold: { endState: "applied", op: "create" }
      };
    case "numbered": {
      const { high, prefix } = pick(rng, pools.numbered);
      return {
        fact: deadlineFact(high.title, high.deadlineAt!),
        gold: {
          endState: "duplicate",
          target: { kind: "action", id: high.id },
          ...(prefix ? { mustNot: ["apply" as const] } : {})
        }
      };
    }
    case "deadline-twin": {
      const [a] = pick(rng, pools.actionTwins);
      return {
        fact: deadlineFact(`${a.title} due`, a.deadlineAt!),
        gold: { endState: "asked", mustNot: ["apply"] }
      };
    }
    case "deadline-neighbour": {
      // The same title a week before the one on the plan: a new instance, not that one moved.
      const a = pick(rng, pools.deadlineNeighbours);
      return {
        fact: deadlineFact(`${a.title} due`, addDays(a.deadlineAt!, -7)),
        gold: { endState: "applied", op: "create" }
      };
    }
    case "ask-same-thread": {
      const f = pick(rng, pools.asks);
      return {
        fact: askFact(`Please ${lower(f.title)}`, f.conversationKey!),
        gold: { endState: "duplicate", target: { kind: "fact", id: f.id } }
      };
    }
    case "ask-new":
      return {
        fact: askFact(`Please ${lower(built.freshAskTitle(rng))}`, `conv-n${int(rng, 1e6)}`),
        gold: { endState: "applied", op: "create" }
      };
    case "ask-uid": {
      const f = pick(rng, pools.askUids);
      return {
        fact: askFact(`Please ${lower(built.freshAskTitle(rng))}`, `conv-n${int(rng, 1e6)}`, f.icsUid!),
        gold: { endState: "duplicate", target: { kind: "fact", id: f.id } }
      };
    }
    case "ask-same-thread-new": {
      const f = pick(rng, pools.asks);
      return {
        fact: askFact(`Please ${lower(built.freshAskTitle(rng))}`, f.conversationKey!),
        gold: { endState: "applied", op: "create" }
      };
    }
    case "ask-twin": {
      const [f] = pick(rng, pools.askTwins);
      return {
        fact: askFact(`Please ${lower(f.title)}`, `conv-n${int(rng, 1e6)}`),
        gold: { endState: "asked", mustNot: ["apply"] }
      };
    }
  }
}

export interface GenerateOptions {
  seed?: string;
  size: PlanSize;
  count: number;
}

/**
 * `count` cases against one plan of `size`. Kinds go round in a seeded shuffled order, so even a
 * short run covers as many kinds as it can and a long one covers all of them evenly. The plan is
 * shared and frozen: a reconciler cannot change it, and the runner need not copy it.
 */
export function generateCases({ seed = DEFAULT_SEED, size, count }: GenerateOptions): ReplayCase[] {
  const built = generatePlan(seed, size);
  const rng = createRng(`${seed}:messages:${size}`);
  const order = [...KINDS];
  for (let i = order.length - 1; i > 0; i--) {
    const j = int(rng, i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const senders = built.plan.contacts.map((c) => c.email!);
  const cases: ReplayCase[] = [];
  for (let i = 0; i < count; i++) {
    const kind = order[i % order.length]!;
    const { from, fact, gold } = draft(kind, built, rng);
    cases.push({
      id: `gen-${size}-${String(i + 1).padStart(5, "0")}-${kind}`,
      tags: ["generated", kind, ...(KIND_TAGS[kind] ?? []), size],
      input: {
        now: NOW,
        timezone: TIMEZONE,
        plan: built.plan,
        message: {
          source: "message-test",
          from: from ?? pick(rng, senders),
          to: "owner@example.test",
          sentAt: "2026-11-09T08:30:00Z",
          facts: fact ? [fact] : []
        }
      },
      gold
    });
  }
  return cases;
}
