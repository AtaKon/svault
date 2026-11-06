# Bring your own database (PostgreSQL)

SVault uses SQLite by default: one `svault.db` file in `DATA_DIR`, no extra service. You can
instead keep everything in PostgreSQL, either a database you already run or the example container
in [`docker-compose.postgres.yml`](../docker-compose.postgres.yml).

Uploaded images and dataset files stay on disk in `DATA_DIR/uploads` with either backend. Only the
relational data moves.

## Configuration

Set `DATABASE_URL` to a PostgreSQL connection string:

```bash
DATABASE_URL=postgres://svault:secret@db:5432/svault
```

Optional settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SV_DATABASE_KIND` | inferred from `DATABASE_URL` | Force `postgres` (or `sqlite`). |
| `PG_POOL_SIZE` | `10` | Maximum pooled connections. |
| `PGSSLMODE` / `DATABASE_SSL` | off | `require`, `prefer`, `no-verify` or `verify-full`. |

The schema is created on first start, with the same tables, indexes and foreign keys as the SQLite
schema. `GET /api/health` reports the active backend as `"database": "sqlite" | "postgres"`.

The npm scripts load `.env` when it exists (`--env-file-if-exists=.env`), so one file works for
`npm run dev`, `npm start` and Docker Compose. `.env` is gitignored; keep database passwords there and
out of the repository.

### Rolling back to SQLite

Stop SVault, remove `DATABASE_URL` (and `PGSSLMODE`) from `.env`, and start it again. The migration
reads a snapshot, so the original `DATA_DIR/svault.db` and uploads are left untouched. Keep that file
until you are happy with the PostgreSQL copy.

### Docker Compose

The repository ships an example override with a PostgreSQL service:

```bash
cp .env.example .env            # set SVAULT_DB_PASSWORD
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
```

The example keeps the `svault-data` volume for uploads and adds `svault-pg` for PostgreSQL.

## Moving an existing vault to PostgreSQL

1. Stop SVault.
2. Take a normal backup from **Settings → Data** (or `npm run backup`).
3. Point `DATABASE_URL` at the empty PostgreSQL database.
4. Copy the data:

   ```bash
   DATABASE_URL=postgres://svault:secret@db:5432/svault npm run migrate:postgres
   ```

   The script reads `DATA_DIR/svault.db` (set `DATA_DIR` if needed), creates the PostgreSQL schema
   and copies every table in foreign-key order. It refuses to write over a database that already has
   users; pass `--force` to truncate and replace it.

5. Start SVault with the same `DATABASE_URL`. Keep the SQLite file and uploads until you have
   verified the result.

## Backups and restore

| Backend | Archive contents | Restore |
| --- | --- | --- |
| SQLite | `svault.db` snapshot (format 1) | The file is swapped before SQLite opens on the next start. |
| PostgreSQL | `database.json` logical dump (format 2) | Rows are written in one transaction during the next start. |

Both archives include `manifest.json`, per-file upload checksums and are downloadable from
**Settings → Data** or with `npm run backup`. Restore validates the checksums and schema version
first, and rejects an archive created on the other backend. `npm run restore -- --in file.zip`
stages the archive; the server applies it on the next start.

Because a PostgreSQL backup is a logical dump, it is portable across PostgreSQL versions but is not
a byte-for-byte snapshot. For disaster recovery you can also use `pg_dump` / `pg_restore` directly.

## Operational notes

- Transactions use a dedicated connection per request and nested calls use savepoints, so concurrent
  requests cannot see each other's uncommitted writes.
- Queries are asynchronous on both backends. SQLite runs synchronously under the hood; PostgreSQL uses
  a connection pool.
- Case-insensitive matching is done with `lower(...)` on both backends. PostgreSQL unique indexes on
  `lower(email)`, `lower(username)`, `lower(vendor name)` and `lower(template name)` mirror SQLite's
  `COLLATE NOCASE`.
- Reminders, the stock engine, receipt parsing and the AI features are backend-independent. Only the
  database adapter and backup format change.

## Tests

The API suite runs against both backends. `npm test` uses a temporary SQLite file. For PostgreSQL,
point `TEST_DATABASE_URL` at a disposable database; the script resets its `public` schema first:

```bash
createdb svault_test
TEST_DATABASE_URL=postgres://postgres@localhost:5432/svault_test npm run test:postgres
```

