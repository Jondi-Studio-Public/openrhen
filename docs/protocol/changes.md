# Proposing protocol changes

Changing a schema, the connection manifest, an agent tool or the engine wire starts as an issue, before a pull request. The maintainer decides (see [GOVERNANCE](../../GOVERNANCE.md)).

Be aware of one cost. The maintainer runs a private add-on on this core and builds it against each change. A seam change may be delayed while that add-on is adapted, and the maintainer carries that cost, not the contributor. A delay is not a rejection.

## Rules for a seam change

- Touching a seam listed in the [seams table](README.md#seams) needs a changelog line with an overlay-impact note (template below). A change that breaks a documented seam without one may be reverted by the maintainer.
- Bump the matching constant in [Versions](versions.md) when its row says so; the test will fail until the page is updated too.
- Additive changes with defaults are preferred. A rename keeps the old name as an alias for one contract version.

## Overlay-impact template

```text
Seam: <name from the seams table>
Change: <one line>
Version bumped: <constant, old -> new, or none>
Add-ons affected: yes / no / unknown
Migration needed by add-ons: <steps, or none>
```

Name no private add-on or private data in the note; "one add-on affected: yes" is enough.
