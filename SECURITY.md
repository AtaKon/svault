# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| `1.x` | Yes |
| `< 1.0` | No |

SVault is a self-hosted application. Security depends on how it is deployed: use HTTPS, keep the host
and image updated, and do not expose an instance with demo data or weak passwords to the internet.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub's security advisories:

<https://github.com/AtaKon/svault/security/advisories/new>

Include as much as you can:

- affected version or commit,
- deployment type (Docker Compose, TrueNAS/Dockge, bare Node) and whether a reverse proxy is used,
- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- relevant logs with secrets removed,
- any suggested fix or mitigation.

You will get an acknowledgement as soon as possible, normally within a few days. This is a
best-effort, unpaid project, so there is no formal SLA or bug bounty. Please give a reasonable amount
of time for a fix before public disclosure. Credit is offered in the advisory and changelog unless you
prefer to stay anonymous.

## Scope

In scope:

- authentication and session handling,
- authorization between houses and roles,
- SQL injection, path traversal and upload handling,
- stored/reflected XSS in the app,
- exposure of AI keys, passwords or other users' data,
- archive generation (dataset export) and file handling,
- dependency vulnerabilities that are reachable in SVault.

Out of scope or already documented as known constraints:

- `/uploads/*` being unauthenticated (documented in [docs/architecture.md](docs/architecture.md)).
  Treat upload URLs as secrets or restrict access at the proxy.
- Password-reset email. This is tracked as a feature in the [roadmap](docs/roadmap.md).
- Issues that require the attacker to already control the host, the Docker daemon or the database.
- Denial of service through huge uploads beyond the configured `MAX_UPLOAD_MB` limit.
- AI provider behaviour or the security of third-party model endpoints.
- Self-XSS or social-engineering-only scenarios.

## Built-in protections

These are handled by SVault itself; reports that bypass them are in scope.

- Rate limits on sign-in, registration, 2FA, passkey sign-in, invite lookup and AI endpoints, plus a
  per-account lockout after repeated failed logins and five wrong codes per 2FA challenge. TOTP codes
  cannot be reused.
- Registration is invite-only once the first account exists (`SV_REGISTRATION`), invites expire, and
  adding an existing user to a house sends them an invite instead of adding them silently.
- Backups and restores are limited to the instance administrator.
- Uploads must be real images (checked by content), are stored under a server-chosen extension, and
  `/uploads` is served with `nosniff`, a sandboxing CSP and forced download for non-images. House
  access is checked before an upload is accepted, and files are deleted with their items, recipes
  and houses.
- The server AI key is only sent to the server's own AI base URL; `SV_OUTBOUND_ALLOW_PRIVATE=false`
  blocks house-configured URLs that point at private networks.
- State-changing API requests from other sites are rejected (Origin / Sec-Fetch-Site check) and the
  app shell is served with a Content-Security-Policy.
- Changing the account email or username needs the current password.
- AI call logs mask card numbers, long IDs, IBANs, emails and phone numbers before storing previews.

## Hardening checklist

If you run SVault outside a trusted LAN:

- Serve it over HTTPS and set `COOKIE_SECURE=true`.
- Keep the app port on the proxy network or localhost; do not publish it directly.
- Make the proxy set `X-Forwarded-For` so the built-in rate limits see client addresses; add
  request-size limits at the reverse proxy.
- Keep registration invite-only or closed (`SV_REGISTRATION`) unless you want open sign-up.
- Use a unique, strong password for every account. Disable or remove demo accounts.
- Keep the image, Docker and the host OS patched.
- Back up the data directory and test a restore.
- Prefer AI keys in environment variables over storing them in house settings.
- Review [docs/deployment.md](docs/deployment.md#security-checklist) for the full deployment
  checklist.
