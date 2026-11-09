// Cases for scripts/test/vendor-terms.test.mjs. Each case builds a throwaway git repository: `base` is committed on top
// of CLEAN (null removes a file), `files` is then applied on top and staged (or committed, with commitAfter), and the
// rule runs with the base commit as the comparison point. A composed case is never committed (no HEAD), like the
// composed tree of sync-core.mjs. This file is exempt from the rule: it is the one place the terms appear as data.
import { createHash } from "node:crypto";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const SHARD = (lane) => `scripts/repository/pending/vendor-terms/${lane}.json`;
export const shard = (lane, metrics) =>
  `${JSON.stringify(
    {
      lane,
      ...Object.fromEntries(
        Object.entries(metrics).map(([metric, files]) => [
          metric,
          { total: Object.values(files).reduce((a, b) => a + b, 0), files }
        ])
      )
    },
    null,
    2
  )}\n`;
// n lines of source, each holding one hit of `word`.
export const lines = (n, word = "google") => Array.from({ length: n }, (_, i) => `// ${word} ${i}\n`).join("");

export const CLEAN = {
  "src/clean.ts": "export const clean = 1;\n",
  "src/old.ts": lines(2),
  [SHARD("other")]: shard("other", { terms: { "src/old.ts": 2 } })
};

const migration = "platform/database/drizzle/0160_x.sql";

export const CASES = [
  // ---------------------------------------------------------------- must fail
  {
    name: "a new src/x.ts naming a provider",
    files: { "src/x.ts": 'export const x = "google";\n' },
    expect: [/src\/x\.ts is new .*\(google\).*Move this to an add-on; see docs\/architecture\/writing-an-addon\.md/s]
  },
  {
    name: "a raised count",
    files: { "src/old.ts": lines(3) },
    expect: [/src\/old\.ts has 3 terms hits but scripts\/repository\/pending\/vendor-terms\/other\.json allows 2/]
  },
  {
    name: "a stale count (the shard is higher than measured)",
    files: { "src/old.ts": lines(1) },
    expect: [/now has 1 terms hits, below the 2 .*Lower src\/old\.ts to 1 in .*--fix-pending/s]
  },
  {
    name: "a deleted file whose shard entry stays",
    files: { "src/old.ts": null },
    expect: [/src\/old\.ts now has 0 terms hits, below the 2/]
  },
  {
    name: "a removed term",
    configAfter: (config) => {
      config.terms.provider = config.terms.provider.filter((term) => term !== "google");
    },
    expect: [/term set provider in scripts\/repository\/rules\/vendor-terms\.json lost "google"/]
  },
  {
    name: "a narrowed word set",
    configAfter: (config) => {
      config.terms.wider.deviceMakers = config.terms.wider.deviceMakers.filter((term) => term !== "garmin");
    },
    expect: [/wider\.deviceMakers .* lost "garmin"/]
  },
  {
    name: "a new docs/archive/y.md with a hit",
    files: { "docs/archive/y.md": "We used google here.\n" },
    expect: [/docs\/archive\/y\.md is under docs\/archive\/ and names a vendor/]
  },
  {
    name: "a migration 0160_x.sql that inserts a provider",
    files: { [migration]: "INSERT INTO t (source) VALUES ('google');\n" },
    expect: [/0160_x\.sql:1 names a vendor \(google\) outside a RENAME or DROP line/]
  },
  {
    name: "a migration that renames a vendor column and also inserts one",
    files: {
      [migration]: "ALTER TABLE t RENAME COLUMN google_id TO account_id;\nINSERT INTO t (source) VALUES ('spotify');\n"
    },
    expect: [/0160_x\.sql:2 names a vendor \(spotify\)/]
  },
  {
    name: "a committed .sync-core.json",
    files: { ".sync-core.json": '{"overlayFiles":[]}\n' },
    commitAfter: true,
    expect: [/\.sync-core\.json is tracked in this repository/]
  },
  {
    name: "a new user-agent string in a file with no platform-tokens row",
    files: { "src/ua.ts": 'export const ua = "Chrome/";\n' },
    expect: [/src\/ua\.ts is new/]
  },
  {
    name: "a capitalised Outlook",
    files: { "src/mail.ts": "// Outlook export\n" },
    expect: [/src\/mail\.ts is new .*\(outlook\)/s]
  },
  {
    name: "jondi alone as an owner term",
    files: { "src/owner.ts": "// jondi owns this\n" },
    expect: [/src\/owner\.ts is new .* owner term/s]
  },
  {
    name: "a new agent-client term",
    files: { "src/agent.ts": "// talks to claude\n" },
    expect: [/src\/agent\.ts is new .* agents hit: an agent-client term/s]
  },
  {
    name: "a new path that holds a vendor word",
    files: { "src/spotify-sync.ts": "export const clean = 1;\n" },
    expect: [/src\/spotify-sync\.ts is new .* a vendor word in its path/s]
  },
  {
    name: "a new provider-specific default (the port)",
    files: { "src/port.ts": "export const port = 11434;\n" },
    expect: [/src\/port\.ts is new .* defaults hit: a provider-specific default/s]
  },
  {
    name: "an edit to an exempt, hashed legal file",
    base: { NOTICE: "Owned by jondi.\n" },
    files: { NOTICE: "Owned by jondi, and edited.\n" },
    exclusions: { legal: [{ path: "NOTICE", sha256: sha256("Owned by jondi.\n") }] },
    expect: [/NOTICE is a legal or governance file .* content changed/s]
  },
  {
    name: "an edit to an exempt, hashed applied migration",
    base: { "platform/database/drizzle/0001_a.sql": "CREATE TABLE google_x (id int);\n" },
    files: { "platform/database/drizzle/0001_a.sql": "CREATE TABLE google_x (id int, y int);\n" },
    exclusions: {
      migrations: [
        { path: "platform/database/drizzle/0001_a.sql", sha256: sha256("CREATE TABLE google_x (id int);\n") }
      ]
    },
    expect: [/0001_a\.sql is an exempt, frozen file and its content changed/]
  },
  {
    name: "an exemption entry for a file that is gone",
    base: { NOTICE: "Owned by jondi.\n" },
    files: { NOTICE: null },
    exclusions: { legal: [{ path: "NOTICE", sha256: sha256("Owned by jondi.\n") }] },
    expect: [/lists the legal file NOTICE, which is not tracked/]
  },
  {
    name: "15 lines with hits split into a new file in another lane",
    base: {
      "portal/server/big.ts": lines(15),
      [SHARD("H")]: shard("H", { terms: { "portal/server/big.ts": 15 } })
    },
    files: {
      "portal/server/big.ts": null,
      "portal/features/part.ts": lines(15),
      [SHARD("H")]: null,
      [SHARD("U")]: shard("U", { terms: { "portal/features/part.ts": 15 } })
    },
    expect: [/Lane U terms total rises from 0 .* to 15/]
  },
  {
    name: "a lane total that rises (new file listed in the shard)",
    files: {
      "src/new.ts": lines(1),
      [SHARD("other")]: shard("other", { terms: { "src/old.ts": 2, "src/new.ts": 1 } })
    },
    expect: [/Lane other terms total rises from 2 .* to 3/]
  },
  {
    name: "a hand-raised count that matches the file",
    files: {
      "src/old.ts": lines(3),
      [SHARD("other")]: shard("other", { terms: { "src/old.ts": 3 } })
    },
    expect: [/Lane other terms total rises from 2 .* to 3/]
  },
  {
    name: "a hit in a lane that had none",
    files: {
      "portal/server/fresh.ts": lines(1),
      [SHARD("H")]: shard("H", { terms: { "portal/server/fresh.ts": 1 } })
    },
    expect: [/Lane H terms total rises from 0 .* to 1/]
  },
  {
    name: "a shard whose total is not the sum of its files",
    files: {
      [SHARD("other")]: JSON.stringify({ lane: "other", terms: { total: 5, files: { "src/old.ts": 2 } } }, null, 2)
    },
    expect: [/total is 5 but its files add up to 2/]
  },
  {
    name: "a platform-tokens row that does not allow a second string",
    base: { "src/ua.ts": 'export const ua = "Chrome/";\n' },
    tokens: [{ category: "platform-detection", path: "src/ua.ts", strings: ["Chrome/"], why: "x" }],
    files: { "src/ua.ts": 'export const ua = "Chrome/";\nexport const other = "Firefox/";\n' },
    expect: [/src\/ua\.ts is new .*\(firefox\)/s]
  },
  {
    name: "a platform-tokens string the file no longer holds",
    tokens: [{ category: "platform-detection", path: "src/clean.ts", strings: ["Chrome/"], why: "x" }],
    expect: [/allows "Chrome\/" in src\/clean\.ts, which no longer contains it/]
  },
  {
    name: "a platform-tokens row for an untracked path",
    tokens: [{ category: "platform-detection", path: "src/missing.ts", strings: ["Chrome/"], why: "x" }],
    expect: [/row for src\/missing\.ts, which is not tracked/]
  },
  {
    name: "a composed tree where the file is not listed",
    composed: true,
    files: {
      "src/o.ts": "// google\n",
      ".sync-core.json": JSON.stringify({ overlayFiles: ["src/other.ts"] })
    },
    expect: [/src\/o\.ts is new/]
  },
  // ---------------------------------------------------------------- must pass
  { name: "the clean baseline", files: {} },
  {
    name: "a lower-case outlook and browser chrome",
    files: { "src/week.ts": "// the week outlook panel, browser chrome\n" }
  },
  {
    name: "a png whose bytes contain fcm",
    files: {
      "docs/images/pixel.png": Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.from("xfcmx")])
    }
  },
  {
    name: "Jondi-Studio-Public in a clone URL",
    files: {
      "src/url.ts": '// git clone https://github.com/Jondi-Studio-Public/openrhen\nexport const org = "Jondi_Studio";\n'
    }
  },
  {
    name: "a count lowered together with its shard",
    files: { "src/old.ts": lines(1), [SHARD("other")]: shard("other", { terms: { "src/old.ts": 1 } }) }
  },
  {
    name: "a new migration that names a vendor column only in RENAME COLUMN",
    files: {
      [migration]: "ALTER TABLE t RENAME COLUMN google_id TO account_id;\nALTER TABLE t DROP COLUMN youtube_key;\n"
    }
  },
  {
    name: "a new generated schema snapshot with a hit",
    files: { "platform/database/drizzle/meta/0160_snapshot.json": '{"google_calendar": 1}\n' }
  },
  {
    name: "a vendor term in the changelog and the lock file",
    files: { "CHANGELOG.md": "Added google.\n", "pnpm-lock.yaml": "google: 1\n", "LICENSES/x.txt": "google\n" }
  },
  {
    name: "15 lines with hits split into a new file in the same lane (no git rename)",
    base: {
      "portal/server/big.ts": `${lines(15)}export const kept = 1;\n`,
      [SHARD("H")]: shard("H", { terms: { "portal/server/big.ts": 15 } })
    },
    files: {
      "portal/server/big.ts": "export const kept = 1;\n",
      "portal/server/big-part.ts": lines(15),
      [SHARD("H")]: shard("H", { terms: { "portal/server/big-part.ts": 15 } })
    }
  },
  {
    name: "hits moved between two files of a lane that stays level",
    base: {
      "portal/server/a.ts": lines(4),
      "portal/server/b.ts": lines(1),
      [SHARD("H")]: shard("H", { terms: { "portal/server/a.ts": 4, "portal/server/b.ts": 1 } })
    },
    files: {
      "portal/server/a.ts": lines(2),
      "portal/server/b.ts": lines(3),
      [SHARD("H")]: shard("H", { terms: { "portal/server/a.ts": 2, "portal/server/b.ts": 3 } })
    }
  },
  {
    name: "a platform-tokens row that allows its strings",
    tokens: [{ category: "platform-detection", path: "src/ua.ts", strings: ["Chrome/", "Firefox/"], why: "x" }],
    base: { "src/ua.ts": 'export const ua = "Chrome/Firefox/";\n' },
    files: {}
  },
  {
    name: "a legal file exempt by hash",
    exclusions: { legal: [{ path: "NOTICE", sha256: sha256("Owned by jondi.\n") }] },
    files: { NOTICE: "Owned by jondi.\n" }
  },
  {
    name: "an archive file listed with its hash",
    exclusions: { archive: [{ path: "docs/archive/z.md", sha256: sha256("google, kept as history\n") }] },
    files: { "docs/archive/z.md": "google, kept as history\n" }
  },
  {
    name: "a composed tree: an overlay file and a patched package.json are skipped",
    composed: true,
    files: {
      "src/o.ts": "// google, an overlay file\n",
      "package.json": '{"scripts": {"x": "google"}}\n',
      ".sync-core.json": JSON.stringify({
        overlayFiles: ["src/o.ts"],
        patchedFiles: { "package.json": ["scripts"] },
        generatedFiles: ["src/gen.ts"]
      }),
      "src/gen.ts": "// google, generated\n"
    }
  }
];
