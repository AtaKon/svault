import test from "node:test";
import assert from "node:assert/strict";
import { POSTGRES_MIGRATIONS, POSTGRES_SCHEMA } from "../database/postgres-schema.js";

/**
 * `CREATE TABLE IF NOT EXISTS` never adds a column to a table that already
 * exists, so on an existing database the base schema runs first and the column
 * only appears when a later `ALTER TABLE ... ADD COLUMN` migration runs. An index
 * in the base schema on such a column therefore fails on every upgrade (and aborts
 * the whole startup transaction) while fresh databases, which is all the tests
 * create, never notice. Create that index in the migration list, after the ALTER.
 */
test("the PostgreSQL base schema only indexes columns an existing database already has", () => {
  const migrations = POSTGRES_MIGRATIONS.join("\n");
  const addedByMigration = new Set<string>();
  for (const match of migrations.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+(\w+)/gi)) {
    addedByMigration.add(`${match[1]}.${match[2]}`.toLowerCase());
  }
  assert.ok(addedByMigration.size > 0, "expected to find ADD COLUMN migrations");

  const problems: string[] = [];
  const indexPattern = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi;
  for (const match of POSTGRES_SCHEMA.matchAll(indexPattern)) {
    const [, index, table, columns] = match;
    for (const raw of columns.split(",")) {
      const column = raw.trim().split(/\s+/)[0].toLowerCase();
      if (addedByMigration.has(`${table}.${column}`.toLowerCase())) {
        problems.push(`${index} on ${table}(${column})`);
      }
    }
  }
  assert.deepEqual(problems, [], "move these indexes into POSTGRES_MIGRATIONS, after the ALTER TABLE that adds the column");
});
