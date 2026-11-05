# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. The maintainer keeps private reporting enabled, so a report stays private until a fix is ready. Please do not open a public issue or pull request for a vulnerability.

Include what you found, how to reproduce it, and the version or commit. You will get an acknowledgement; fixes for confirmed problems are released as patch versions and noted in the [changelog](CHANGELOG.md).

## Supported versions

OpenRhen is pre-1.0. Only the latest release receives security fixes.

## Scope

OpenRhen is designed as a **single-user, self-hosted** application. The default install publishes the portal on the loopback address only and has owner sign-in switched off, which is safe only on a machine you alone use.

In scope:

- Authentication bypass when `OPENRHEN_OWNER_AUTH=require` is set.
- Leaking a stored credential (connection secrets live in the outbound proxy, never in the portal or the browser).
- Injection, request forgery or path traversal in the portal, CLI or services.
- Anything that lets imported content, a model response or a connection issue commands.
- Supply-chain issues in the released OpenClaw plugin package or the Dockerfiles and build (no images are published yet).

Out of scope:

- Running with owner sign-in off and exposing the portal beyond loopback. [Self-hosting](docs/operations/self-hosting.md#exposing-it-beyond-this-machine) explains how to lock it down first.
- Multi-user isolation: there is one user per install by design.
- Findings that need an attacker who already controls the host, the database or the environment file.
- Denial of service by someone who can already reach an unauthenticated install.
