# Writing an add-on

An add-on is a set of files that you keep outside OpenRhen and lay over it, so you can add your own pages, API routes, services and settings and still take every OpenRhen update without a merge conflict. This guide says which seams exist, how to use each, and what an add-on must never do. The worked example is `integrations/addon-example/`; `scripts/addon/conformance.mjs` proves it works against the current core on every pull request.

## The seams

| Seam | What an add-on adds | Where it lives | What core reads |
|---|---|---|---|
| Compose | Services, and environment or secrets on core services | `compose.addon.yaml` | `COMPOSE_FILE` in `.env` |
| Env | Settings and generated secrets | `addons/<id>/env.example` | `init-env` and `check-env` |
| Pages and API routes | Screens and handlers | `portal/app/(addon)/<folder>/` | The portal build |
| Navigation | Go to palette entries | `nav.ts` beside the pages | A glob in `portal/components/addon-nav.ts` |
| Write paths | A handler's plan-input writes, declared | `write-paths.json` beside the handler | `scripts/repository/addon-routes.mjs` |
| Database | Tables of its own, migrated as a second set | `platform/database/addon-drizzle/` | The deploy migrator, and the integration suites (`addon-aware-migrate.ts`) |
| Contracts | Agent scopes, route classes, MCP tools | `platform/contracts/src/private/index.ts` | The contracts package |
| Other stubs | Portal, worker and database hooks | The files in `scripts/repository/seams.json` | Imported by core |

The command line has its own drop-in (`tools/cli/extensions/<name>/command-module.ts`), not a stub. The seams core offers to any extension, tested or not, are listed in [Protocol](../protocol/README.md#seams); the stubs in "Single-slot stubs" below.

## Step by step

1. Make a folder for the add-on in your own repository, with an `overlay/` tree that mirrors OpenRhen's layout. Start by copying `integrations/addon-example/overlay/`.
2. Pick an id in lowercase kebab-case, such as `notes`. Your env fragment and files live under `addons/notes/`, and your routes under `portal/app/(addon)/`.
3. Write `compose.addon.yaml`, `addons/notes/env.example`, and your pages and routes.
4. Lay the overlay over a checkout of OpenRhen (copy it on top; a build script or `rsync` does this), then set `COMPOSE_FILE` in `.env`.
5. Run `node scripts/addon/conformance.mjs --addon <path to a folder holding overlay/>` from the checkout, with the add-on folder outside the checkout (inside it, `structure:check` and the stub list would see your overlay as core files; only the bundled example is exempt). It must pass before you deploy.
6. Run `node scripts/setup/init-env.mjs` to fold your env fragment into `.env`, then bring the stack up as usual.

## Compose

Compose merges files, so an add-on can add services and also append to a core service. Core's `compose.yaml` is never edited. Set the list in `.env`, which both Compose and the setup scripts read:

```
COMPOSE_FILE=compose.yaml:compose.addon.yaml
```

The separator is `:` by default and `;` on Windows. Set `COMPOSE_PATH_SEPARATOR` to override it; whichever you choose must match what the file list uses. A relative path resolves from the directory of the first file.

Rules for `compose.addon.yaml`:

- **Profiles.** Every service you add names its `profiles`, normally `["planning", "app"]`, so it starts only in a stack that asked for it. A service with no profiles is refused by the model reader (`addonEntries`) because Compose would start it everywhere.
- **Dependencies.** `depends_on` may name core services and your own. A name that is not a service is a conformance failure.
- **Environment.** Under a core service such as `portal` or `engine-worker`, list only the names you add; Compose appends them to what core sets. Core passes through only the names it lists, which is why your service must list its own.
- **Secrets.** Add `x-openrhen: { secrets: [NAME] }` to a service. `check-env` (and the deploy guard, once your layer calls `registerComposeAddons`) then refuses to start the stack while `NAME` is blank or still `replace-before-lan-use`. Each name must be declared with `@secret` in an env fragment.
- **Build override.** A service may point `build.context` and `build.dockerfile` at your own Dockerfile. Core Dockerfiles copy only core packages, so an add-on that ships packages of its own must override the build of each core service it extends with a Dockerfile that builds core plus its packages. The example overrides the build of its own service.

Which scripts read the merged model today: `scripts/setup/check-env.mjs` reads it itself whenever `COMPOSE_FILE` is set, so it checks your services' secrets. The deploy scripts (`service-selection`, `required-secrets`) learn of add-on services only through `registerComposeAddons` in `scripts/deploy/compose-addons.mjs`, and nothing in core calls it, because this repository has no deploy entry point. **Your deploy layer must call `registerComposeAddons()` before it builds its service and secret maps**; conformance exercises that function against your merged model but cannot know whether your layer calls it.

## Environment fragments

`addons/<id>/env.example` is dotenv syntax. Comment lines directly above a `KEY=` line travel with it into `.env`. A `# @secret` line above a key marks a secret: a blank or placeholder value is replaced by a generated 64-character token, and the value is never printed. An existing value is never changed, and a second run changes nothing. A key that core's `.env.example` or an earlier add-on (sorted by id) already sets is a conflict; pick a prefix of your own, such as `NOTES_`.

## Pages, API routes and write paths

`portal/app/(addon)/` is a route group that core never writes. The group name is not part of the URL: `(addon)/hello/page.tsx` is served at `/hello` and `(addon)/api/example-addon/hello/route.ts` at `/api/example-addon/hello`.

- Wrap every handler in `withRoute("<its URL>", ...)`.
- `nav.ts`, whose default export is a `NavExtension`, adds a palette entry. It may import types from `@/components/nav-extensions` only.
- `write-paths.json` is needed only if a handler writes a plan-input table. It maps each path inside its own folder to `{ "class": "owner" | "helper", "reason": "..." }`. An add-on may not claim the exemptions core reserves, and a write to plan data goes through `recordStateChange`.
- An API route is refused to agent tokens until you classify it. Register the route in the contracts stub with `registerContractsExtension({ id, knownScopes, routes })`. For remote MCP use a `portal/drop-ins/<id>/register.ts` (a folder your add-on creates; core has none).
- MCP tools: `registerContractsExtension({ id, mcpTools: { after, tools, overrides } })` places `tools` after the named core tool. `overrides` replaces core entries of the same name, either as a written-out list or, preferably, as a function `(coreEntries) => entries` that derives the replacements from core's own entries (`MCP_CORE_TOOL_MANIFEST`), so a core wording change reaches them without regenerating anything. A tool file that `pnpm --filter @openrhen/cli manifest` generates refers to the shared write-argument text as `MCP_COMMON_PARAMS[...]` rather than copying it. The tool-list byte caps in `tools/cli/test/remote-manifest.test.ts` apply to the result.

Limits: `structure:check` fails when your URL can also be answered by a core route (a `[id]` segment counts as any one segment) or by another add-on file, so you cannot shadow a core page. Pages here share the portal's authentication and layout; they cannot change either. Tests named `*.test.ts` or `*.test.tsx` under the group run with the portal's unit suite.

## Single-slot stubs

Some seams are lists in code rather than data, so core ships an empty file for each (`**/private/index.ts` and `scripts/*/private/index.mjs`). An add-on replaces the whole file. That is by design, and it means two add-ons cannot both use a stub: the layer that combines add-ons owns the file and imports each add-on's registration from it. `scripts/repository/seams.json` is the one list of these files. Conformance does not yet accept all of them: it lets only `SINGLE_SLOT_STUBS` in `scripts/addon/conformance.mjs` differ from core (today, `platform/contracts/src/private/index.ts`), so a conformant add-on can use only the contracts stub for now.

## What an add-on must not do

- Edit `compose.yaml`, a core page, a core route, or any core file other than a documented stub.
- Add a file outside `compose.addon.yaml`, `addons/<id>/` and `portal/app/(addon)/`, apart from a stub.
- Serve a URL a core route serves, or reuse a core environment variable name.
- Start a service with no profile, or read a secret that no `@secret` fragment declares.
- Write to a plan-input table without going through `recordStateChange`.
- Commit credentials. Real values stay in `.env`, which is not tracked.

## How conformance runs

`node scripts/addon/conformance.mjs` copies the repository without `.git`, `.env` or `node_modules` to a scratch folder, copies the add-on's `overlay/` over it, and then checks:

1. Only add-on owned paths and the single-slot stubs differ from core; the failure names the path.
2. `structure:check` passes on the merged tree, including the route collision check.
3. `docker compose config` merges `compose.yaml` and `compose.addon.yaml`, every add-on service has profiles, depends on services that exist, and lists only declared secrets, and `registerComposeAddons` registers the add-on services.
4. The env fragments fold into a fresh `.env` once and a second run changes nothing.
5. No add-on route collides with a core route.

Any failure prints one line saying what and where, and the exit code is 1. Pull requests run it as the `Add-on conformance` job, which `ci-ok` requires. It needs Node and Docker with Compose; it builds and starts nothing, so a full build and a boot check remain your own responsibility.
