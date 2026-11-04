# Governance

OpenRhen is maintained by its founding maintainer, Jondi Haynes, with help from anyone who contributes. This is a benevolent-maintainer project while it is small; the rules below say how decisions are made so they are not a surprise.

## Roles

- **Maintainer**: merges pull requests, cuts releases, and owns the roadmap. Listed in [CODEOWNERS](.github/CODEOWNERS).
- **Contributor**: anyone who opens an issue, a pull request or a review. Contributors sign off commits under the [DCO](CONTRIBUTING.md#developer-certificate-of-origin); there is no CLA.

## How decisions are made

- Routine changes merge when the maintainer approves and the checks in CONTRIBUTING pass.
- Larger changes (a new connection capability, a schema or contract change, a change to the planning rules) start as an issue describing the problem and the proposed behaviour. The maintainer decides after discussion; the reasoning is recorded in the issue.
- Planning behaviour is deterministic by design. A change that makes the same input produce a different plan needs a test that shows why.
- Disagreements are settled by the maintainer. Anyone may fork under the licence.

## Becoming a maintainer

Sustained, high-quality contributions and good judgement in review lead to an invitation from the existing maintainers. Maintainers who are inactive for a year may be moved to emeritus.

## Releases and versioning

Releases are tagged from `main` and follow semantic versioning once 1.0 ships; before then, minor versions may break compatibility and the [changelog](CHANGELOG.md) says how.

## Conduct and security

Conduct follows the [Code of Conduct](CODE_OF_CONDUCT.md). Vulnerabilities follow [SECURITY.md](SECURITY.md).

## Changing this document

Open a pull request. The maintainer merges it after a week for comment unless it fixes a mistake.
