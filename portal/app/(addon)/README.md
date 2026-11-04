# Add-on routes

This folder is reserved for add-ons. Core never writes here, so an add-on can add pages and API routes by
dropping files in, with no core file edited. `(addon)` is a route group: it is not part of the URL, so
`app/(addon)/notes/page.tsx` is served at `/notes` and `app/(addon)/api/notes/route.ts` at `/api/notes`.

An add-on keeps its files in a folder of its own and adds:

- `page.tsx` and `route.ts` files, as anywhere under `app/`. Wrap each handler in `withRoute("<its URL>", ...)`.
- `nav.ts` (optional): its default export is a `NavExtension` from `@/components/nav-extensions`; the page then
  appears in the Go to palette. `components/addon-nav.ts` finds it by glob.
- `write-paths.json` (only if a handler writes a plan-input table): maps each file in that folder to
  `{ "class": "owner" | "helper", "reason": "...", "owners": [...] }`, as `scripts/repository/write-path-registry.mjs`.
- For an API route, the agent classification (`registerContractsExtension` with `routes`, from
  `platform/contracts/src/extensions.ts`) and, for remote MCP, `registerMcpRoutes` from a
  `portal/drop-ins/<id>/register.ts`. A route not classified is refused to agent tokens.

`pnpm structure:check` fails when a URL here is also served by a core route, or by another add-on file.
Tests named `*.test.ts` or `*.test.tsx` here run with the portal's unit suite.
