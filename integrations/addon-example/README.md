# Example add-on

A minimal add-on that uses every seam with fake data. CI copies it over a clean checkout and runs
`node scripts/addon/conformance.mjs`; it is also the template to copy when you write your own. The guide is
[Writing an add-on](../../docs/architecture/writing-an-addon.md).

The `overlay/` folder is a tree laid over the repository root. It is not a pnpm package, so it adds nothing to
the lockfile, and nothing in it is built or linted where it is stored.

| Overlay path | Seam |
|---|---|
| `compose.addon.yaml` | Compose merge: an extra service with profiles, `depends_on` a core service, env and `x-openrhen` secrets added to `portal`, a build override |
| `addons/example/env.example` | Env fragment with an `@secret` that `init-env` generates |
| `addons/example/Dockerfile`, `service.mjs` | The add-on service's own image |
| `portal/app/(addon)/hello/page.tsx` | A page, served at `/hello` |
| `portal/app/(addon)/hello/nav.ts` | A Go to palette entry |
| `portal/app/(addon)/hello/write-paths.json` | Write-path registration, as data |
| `portal/app/(addon)/api/example-addon/hello/route.ts` | An API route, served at `/api/example-addon/hello` |
| `platform/contracts/src/private/index.ts` | Contracts extension, in the single-slot stub core ships empty |

Compose note: `check-env` reads the merged model itself. Core never calls `registerComposeAddons`, so a deploy
layer that wants `service-selection` and `required-secrets` to know the add-on's services must call it; the
conformance script exercises that function against this example.
