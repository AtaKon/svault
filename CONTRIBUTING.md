# Contributing to SVault

Thanks for taking the time to help. SVault is a small, self-hosted project, so the best
contributions are focused, tested and easy to review.

## Before you start

- **Small fix or typo:** open a PR directly.
- **Bug:** open an issue with the bug report template. If you already know the fix, link the issue in
  the PR.
- **Feature:** open an issue first using the feature request template. Anything larger than a small
  improvement should be agreed on before code is written. The [roadmap](docs/roadmap.md) lists what is
  already planned.
- **Security issue:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).

Check the open issues and pull requests to avoid duplicate work. Comment on an issue if you plan to
take it, so others know.

## Development setup

Requirements: Node.js 22.13+, npm 10+.

```bash
git clone https://github.com/AtaKon/svault.git
cd svault
npm install
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:4000/api/health
- Optional demo data: `npm run seed`

More detail, including scripts and the database, is in [docs/development.md](docs/development.md).

## Making a change

1. Fork the repository (or create a branch if you have write access).
2. Branch from the default branch: `feat/shopping-list`, `fix/fifo-expiry`, `docs/deployment-tls`.
3. Keep the diff focused. Do not reformat unrelated files or upgrade dependencies in a feature PR.
4. Add or update tests for behaviour changes.
5. Update the documentation when the API, configuration, UI or deployment changes.
6. Run the checks:

```bash
npm run typecheck
npm test
npm run build
```

## Coding guidelines

- Match the surrounding style: TypeScript, functional React components, Tailwind utility classes.
- Server routes validate with Zod and authorize with `requireHouse` before touching data.
- Stock mutations go through `server/services/stock.ts`; do not write stock tables from a route.
- Use parameterized SQL. Never build SQL with string interpolation.
- Keep shared response shapes in `shared/types.ts` and serializers in `server/serialize.ts`.
- Prefer the standard library. A new runtime dependency needs a short justification in the PR.
- Do not add telemetry, analytics or a cloud service call that is not explicitly configured.
- UI changes must work at 360px wide, with keyboard navigation and in dark mode.

## Commit messages

A conventional prefix is welcome but not enforced:

```
feat: add shopping list from recipe ingredients
fix: keep FIFO order when expiry dates are equal
docs: document NPM IPv4 resolver workaround
test: cover CSV decimal comma parsing
```

Write the subject in the imperative mood and explain *why* in the body when it is not obvious.

## Pull requests

Use the PR template and include:

- **What changed** and why, in behaviour terms.
- **How it was tested** (commands, manual steps, devices/browsers).
- **Screenshots** for UI work, before/after if possible.
- **Linked issue** (`Closes #12`).
- **Breaking changes or migrations**, if any.

Keep PRs small enough to review in one sitting. Draft PRs are welcome for early feedback.

A PR is ready when:

- [ ] `npm run typecheck`, `npm test` and `npm run build` pass.
- [ ] New behaviour has tests, or the PR explains why a test is impractical.
- [ ] Permissions follow the existing role model.
- [ ] API or configuration changes are documented.
- [ ] No secrets, `.env` files, databases or uploaded images are committed.
- [ ] The changelog has an entry under `Unreleased` for user-visible changes.

## Documentation

Documentation lives in [`docs/`](docs/):

- `user-guide.md` - how to use the app.
- `architecture.md` - how it works internally.
- `api.md` - endpoint reference.
- `deployment.md` - Docker, proxies, backups, upgrades.
- `development.md` - local setup and conventions.
- `roadmap.md` - planned work.

Screenshots go in `docs/screenshots/`. Keep image sizes reasonable and use descriptive alt text.

## Good first issues

Issues labelled `good first issue` are scoped to be a reasonable first contribution. The current
entry points are the CSV importer ([#10](https://github.com/AtaKon/svault/issues/10)) and the GHCR
image workflow ([#12](https://github.com/AtaKon/svault/issues/12)).

## Be decent

Assume good faith, keep discussion technical, and respect that maintainers work on this in their own
time. Harassment, discrimination and personal attacks are not welcome.
