# Contributing to OpenRhen

Thank you for helping. OpenRhen is pre-1.0, so interfaces can still change; open an issue before large work so nobody builds something that will not merge.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Developer Certificate of Origin

There is no CLA. Every commit must carry a `Signed-off-by` line, which certifies the Developer Certificate of Origin 1.1 below. Add it with `-s`:

```text
git commit -s -m "Describe the change"
```

Forgot it? Add it to every commit on your branch and push again:

```text
git rebase --signoff main
git push --force-with-lease
```

The sign-off name and email must match the commit author. Maintainers will ask you to sign off any commit that is missing it.

```text
Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Making a change

1. Fork the repository and branch from `main`.
2. Follow [Development](docs/operations/self-hosting.md#running-from-source) to run from source.
3. Add or update automated tests with the change. Behaviour that the planner decides belongs in `engine/core` with a test; see [Engine logic](docs/engine/logic.md).
4. Run `corepack pnpm check`, `corepack pnpm typecheck` and `corepack pnpm test` before pushing. `corepack pnpm test:integration` needs a throwaway local Postgres; CI runs it against a `postgres:17` service, so locally run `node scripts/setup/init-env.mjs --mode source` and `docker compose up -d postgres` (see [Development](docs/operations/self-hosting.md#running-from-source)), then check that `.env` has a loopback `POSTGRES_ADMIN_URL` (the suites refuse any other host and make and drop their own databases).
5. Update the document that owns the behaviour you changed (see the [documentation index](docs/README.md)). Do not copy a rule into a second place.
6. Open a pull request using the template. Squash merge is the only merge method.

## What CI checks

Every pull request, including one from a fork, runs on GitHub-hosted runners with a read-only token and no secrets. The `ci-ok` check passes only when all of these pass: `pnpm check`, typecheck, unit and integration tests, the engine benchmark, the build, the production browser smoke, the self-host smoke on x86-64 and Arm64, workflow lint and a secret scan (`Hygiene`), and REUSE compliance. `main` requires both `ci-ok` and `DCO`. `DCO` is a separate check on purpose, not part of `ci-ok`: it fails the pull request if a commit lacks a matching `Signed-off-by` line in its trailer block, if the pull request holds a merge commit (rebase instead), or if it lists no commits. Pull requests opened by Renovate are exempt from the sign-off. Workflow lint and the secret scan download actionlint and gitleaks from their release pages and check a pinned sha256 before running them; the browser the production smoke uses is fetched over HTTPS without a checksum pin. A first-time contributor's run waits for a maintainer's approval.

## Ground rules

- No new telemetry, analytics or phone-home calls. See the README.
- No secrets, personal data or real imported content in code, tests, fixtures or screenshots. Use synthetic data.
- New third-party calls belong in a connection behind the outbound proxy ([Writing a connection](docs/architecture/writing-a-connection.md)).
- Do not edit an existing migration. Add a new one.
- Every source file you add is covered by Apache-2.0 (see [REUSE.toml](REUSE.toml)); do not add code you cannot license that way.
