# Replay fixtures

Each `*.json` file is one anonymised planning input plus the decision the engine is expected to
reach. `../replay.test.ts` runs them. Fixtures are imported explicitly there rather than globbed, so
this package keeps no filesystem dependency — add the import and the `fixtureFiles` entry when you
add a file.

The risk in this engine is calibration, not logic: a weight change or a threshold move can silently
reverse a recommendation without breaking a unit test. These fixtures exist to make that visible
before it ships. The planning logic design §16 calls them replay tests.

## Adding a fixture

Capture a case that surprised you in real use, strip anything identifying, and record what the
engine *should* decide:

```json
{
  "name": "short description of the situation",
  "why": "what this fixture protects against",
  "calculatedAt": "2026-08-07T07:00:00.000Z",
  "horizonDays": 180,
  "capacity": { "mode": "automatic", "usableFraction": 0.85, "timezone": "Australia/Sydney", "dayStartTime": "07:00", "dayEndTime": "22:00" },
  "currentEnergy": "high",
  "assertedConditions": [],
  "projects": [{ "id": "p", "deadlineDays": 4, "value": 3, "consequence": 3 }],
  "actions": [{ "id": "a", "projectId": "p", "minutes": 120 }],
  "commitments": [],
  "expect": { "primaryActionId": "a", "criticalRank": 2, "health": { "p": "on_track" } }
}
```

Every `expect` key is optional; assert only what the fixture is actually about. Besides the keys
above, a fixture may pin `criticalTier` (the named tier of the primary — prefer it over the rank
number, which only fixes order), `candidateTiers` (tier by action id, eligible or not), `overdue`
(by project id), `proposalFeasible` (projects whose forecast must propose a feasible date), and
`noFit` (`kind`, `boundaryKind`, `nextFitActionId`), and `dayPlan` (the projected day through the
daily horizon in the compact one-line-per-block form `test/model/day-plan-harness.ts` writes);
`dailyHorizonMinutes` at the top level sets the daily planning horizon relative to `calculatedAt`. When a fixture fails
after a deliberate change, update the expectation in the same commit and say why in the message —
a changed replay expectation is the record that a decision moved.
