# SVault documentation

SVault is a self-hosted vault for everything a household owns and cooks: stock, prices, recipes,
food ideas, reminders and labelled photo datasets. It runs as one Node.js process and one Docker
container, with SQLite and a local uploads folder.

If you just want to run it, start with the [quick start](../README.md#quick-start-docker). The
guides below go deeper.

| Guide | What it covers |
| --- | --- |
| [User guide](user-guide.md) | Houses, roles, inventory, stock actions, recipes, photo datasets, reminders and settings |
| [Architecture](architecture.md) | Runtime, data model, auth, stock engine, AI fallbacks, uploads, PWA and design trade-offs |
| [API reference](api.md) | Conventions, roles, every endpoint, request/response examples and errors |
| [Deployment](deployment.md) | Docker Compose, environment variables, HTTPS, TrueNAS, backups and upgrades |
| [Development](development.md) | Local setup, scripts, tests, project layout and contribution workflow |
| [Roadmap](roadmap.md) | Planned features, priorities and the reasoning behind them |

## Other project files

- [Contributing](../CONTRIBUTING.md) - how to propose a change and what a good PR looks like.
- [Security policy](../SECURITY.md) - supported versions and private vulnerability reporting.
- [Changelog](../CHANGELOG.md) - release history.
- [Deploying with Dockge on TrueNAS](../deploy/dockge/README.md) - the NAS-specific walkthrough.

## Getting help

- **Bug or unexpected behaviour:** open an issue with the bug report template and include the
  version, deployment type and reproduction steps.
- **Feature idea:** open an issue with the feature request template. The [roadmap](roadmap.md) shows
  what is already planned; comments and use cases are welcome on those issues.
- **Security problem:** do not open a public issue. Follow [SECURITY.md](../SECURITY.md).

## Versioning

SVault follows [semantic versioning](https://semver.org/). The `1.x` line is the current stable
series. Database schema changes are additive whenever possible; always take a backup before
upgrading across minor versions.
