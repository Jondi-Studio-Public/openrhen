# OpenRhen documentation

OpenRhen is a self-hosted planner that works out what to do right now (see the [README](../README.md)).

Start with the guide that matches what you want to do. Open only what you need.

| I want to... | Read |
|---|---|
| Install it and try it | [Self-hosting](operations/self-hosting.md), then the [user guide](product/user-guide.md) |
| Learn what each screen does | [User guide](product/user-guide.md), [Living the day](product/living-the-day.md), [Building the plan](product/building-the-plan.md), [Settings and connections](product/settings-and-connections.md) |
| Understand how a plan is calculated | [Engine logic](engine/logic.md) |
| Understand how the parts fit together | [Architecture overview](architecture/overview.md) |
| Connect an outside service | [Writing a connection](architecture/writing-a-connection.md) |
| Extend it with your own pages, services and settings | [Writing an add-on](architecture/writing-an-addon.md) |
| Build against the agent surface or the seams | [Protocol](protocol/README.md): [versions](protocol/versions.md), [auth](protocol/auth.md), [proposing changes](protocol/changes.md) |
| Record what you did on a Windows PC | [Desktop activity agent](architecture/desktop-activity-agent.md), [rhen-watch](../tools/rhen-watch/README.md) |
| Store and read back what a PC, phone or export recorded | [Activity store](architecture/activity-store.md) |
| Run it safely beyond one machine | [Locking down the API](operations/locking-down.md) |
| Back up, restore, upgrade | [Database and backups](operations/database-and-backups.md) |
| Get leave-by reminders on a phone | [Web push](operations/web-push.md), [Location ping](operations/location-ping.md) |
| Record what your iPhone does | [iPhone Shortcuts feed](operations/iphone-shortcuts-feed.md) |
| Contribute | [CONTRIBUTING](../CONTRIBUTING.md), [GOVERNANCE](../GOVERNANCE.md) |

Each document owns its subject. If two documents seem to disagree, the code and its tests are the final word; please open an issue.

OpenRhen is pre-1.0: interfaces and screens can still change between minor versions, and the [changelog](../CHANGELOG.md) says when they do.
