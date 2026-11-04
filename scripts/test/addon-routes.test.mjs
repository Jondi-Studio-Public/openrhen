import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  findCollisions,
  listRoutes,
  loadAddonWriters,
  routeUrl,
  staticBeatsDynamic,
  urlsOverlap
} from "../repository/addon-routes.mjs";

const tree = (files) => {
  const root = mkdtempSync(join(tmpdir(), "addon-routes-"));
  for (const [file, text] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
};

test("a route group does not appear in the URL", () => {
  assert.equal(routeUrl("(addon)/notes/page.tsx"), "/notes");
  assert.equal(routeUrl("(addon)/api/notes/route.ts"), "/api/notes");
  assert.equal(routeUrl("page.tsx"), "/");
  assert.equal(routeUrl("(addon)/notes/helper.ts"), null);
  assert.equal(routeUrl("(addon)/notes/nav.ts"), null);
  assert.equal(routeUrl("today/@slot/page.tsx"), null);
});

test("dynamic segments and catch-alls overlap what they can match", () => {
  assert.equal(urlsOverlap("/notes", "/notes"), true);
  assert.equal(urlsOverlap("/notes", "/today"), false);
  assert.equal(urlsOverlap("/items/[id]", "/items/new"), true);
  assert.equal(urlsOverlap("/items/[id]", "/items"), false);
  assert.equal(urlsOverlap("/docs/[...rest]", "/docs/a/b"), true);
  assert.equal(urlsOverlap("/docs/[...rest]", "/docs"), false);
  assert.equal(urlsOverlap("/docs/[[...rest]]", "/docs"), true);
});

test("an add-on route that claims a core URL is reported, and one that does not is not", () => {
  const root = tree({
    "portal/app/today/page.tsx": "",
    "portal/app/api/commitments/route.ts": "",
    "portal/app/(addon)/notes/page.tsx": "",
    "portal/app/(addon)/api/notes/route.ts": "",
    "portal/app/(addon)/today/page.tsx": "",
    "portal/app/(addon)/api/commitments/route.ts": ""
  });
  try {
    const errors = findCollisions(listRoutes(root));
    assert.equal(errors.length, 2);
    assert.match(errors.join("\n"), /\(addon\)\/today\/page\.tsx serves \/today, which core route .*today\/page\.tsx/);
    assert.match(errors.join("\n"), /\(addon\)\/api\/commitments\/route\.ts serves \/api\/commitments/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two add-on files for one URL are reported", () => {
  const clash = tree({ "portal/app/(addon)/a/page.tsx": "", "portal/app/(addon)/a/route.ts": "" });
  try {
    assert.equal(findCollisions(listRoutes(clash)).length, 1);
  } finally {
    rmSync(clash, { recursive: true, force: true });
  }
});

test("a tree with no add-on group has no add-on routes and no collisions", () => {
  const root = tree({ "portal/app/today/page.tsx": "" });
  try {
    assert.deepEqual(findCollisions(listRoutes(root)), []);
    assert.deepEqual(loadAddonWriters(root), { writers: {}, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an add-on registers its write paths as data, inside its own folder", () => {
  const own = "portal/app/(addon)/notes/";
  const root = tree({
    [`${own}write-paths.json`]: JSON.stringify({
      [`${own}route.ts`]: { class: "owner", reason: "calls recordStateChange" },
      [`${own}store.ts`]: { class: "helper", reason: "called from route.ts", owners: [`${own}route.ts`] },
      "portal/server/persistence/postgres/entity-commands.ts": { class: "owner", reason: "not mine" },
      [`${own}seed.ts`]: { class: "bootstrap", reason: "exemption core reserves" },
      [`${own}empty.ts`]: { class: "owner", reason: " " }
    })
  });
  try {
    const { writers, errors } = loadAddonWriters(root);
    assert.deepEqual(Object.keys(writers), [`${own}route.ts`, `${own}store.ts`]);
    assert.equal(errors.length, 3);
    assert.match(errors.join("\n"), /entity-commands\.ts, which is outside the folder it sits in/);
    assert.match(errors.join("\n"), /class bootstrap/);
    assert.match(errors.join("\n"), /empty\.ts no reason/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository's own tree passes", () => {
  assert.deepEqual(findCollisions(listRoutes()), []);
  assert.deepEqual(loadAddonWriters().errors, []);
});

test("a fixed segment beside a [param] is not a collision between add-on routes, but identical shapes and core overlaps are", () => {
  assert.equal(staticBeatsDynamic("/people/[id]", "/people/messages"), true);
  assert.equal(staticBeatsDynamic("/people/[id]", "/people/[slug]"), false);
  assert.equal(staticBeatsDynamic("/docs/[...rest]", "/docs/a"), false);
  const route = (url, file, addon = true) => ({ url, file, addon });
  assert.deepEqual(
    findCollisions([route("/people/[id]", "a/[id]/route.ts"), route("/people/messages", "a/messages/route.ts")]),
    []
  );
  assert.equal(
    findCollisions([route("/people/[id]", "a/[id]/route.ts"), route("/people/[slug]", "a/[slug]/route.ts")]).length,
    1
  );
  assert.equal(
    findCollisions([route("/people/[id]", "core/[id]/route.ts", false), route("/people/messages", "a/m/route.ts")])
      .length,
    1
  );
});
