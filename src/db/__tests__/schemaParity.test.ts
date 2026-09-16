import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATEMENTS } from "../ensureSchema";
import { EXPECTED_COLUMNS } from "../verifySchema";

// Production runs NO migrations: src/db/ensureSchema.ts is the migration, and
// src/db/verifySchema.ts is the assertion that it ran. A Prisma field added to
// only one of the three files type-checks, passes every other test, and then
// fails at runtime against a column that does not exist. This file is the guard
// for exactly that: it reads all three and insists they agree.
//
// It parses rather than connecting to a database, so it runs anywhere.

const schemaPath = join(process.cwd(), "prisma", "schema.prisma");
const schemaSrc = readFileSync(schemaPath, "utf8");

// ---- prisma/schema.prisma ----

interface PrismaModel {
  model: string;
  table: string;
  columns: string[];
}

function parsePrismaModels(src: string): PrismaModel[] {
  const lines = src.split("\n");
  const modelNames = new Set<string>();
  for (const line of lines) {
    const m = /^model\s+(\w+)\s*\{/.exec(line);
    if (m) modelNames.add(m[1]);
  }

  const models: PrismaModel[] = [];
  let current: { model: string; table: string | null; columns: string[] } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = { model: open[1], table: null, columns: [] };
      continue;
    }
    if (!current) continue;
    if (line === "}") {
      assert.ok(current.table, `model ${current.model} has no @@map, so its table name is implicit`);
      models.push({ model: current.model, table: current.table as string, columns: current.columns });
      current = null;
      continue;
    }
    const map = /^@@map\("([^"]+)"\)/.exec(line);
    if (map) {
      current.table = map[1];
      continue;
    }
    if (line === "" || line.startsWith("//") || line.startsWith("@@")) continue;

    const field = /^(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);
    if (!field) continue;
    const [, name, type, list] = field;
    // Relation fields carry no column of their own: a list relation, an
    // explicit @relation, or a field typed as another model.
    if (list || line.includes("@relation") || modelNames.has(type)) continue;
    current.columns.push(name);
  }
  return models;
}

// ---- src/db/ensureSchema.ts ----

// table -> columns, built from CREATE TABLE bodies plus every ALTER ... ADD COLUMN.
function parseEnsureSchema(statements: string[]): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    const set = tables.get(table) ?? new Set<string>();
    set.add(column);
    tables.set(table, set);
  };

  for (const statement of statements) {
    const create = /CREATE TABLE IF NOT EXISTS "([^"]+)"\s*\(([\s\S]*)\)\s*$/.exec(statement.trim());
    if (create) {
      const [, table, body] = create;
      for (const rawLine of body.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("CONSTRAINT")) continue;
        const col = /^"([^"]+)"\s+\S/.exec(line);
        if (col) add(table, col[1]);
      }
      continue;
    }
    const alter = /ALTER TABLE "([^"]+)" ADD COLUMN IF NOT EXISTS "([^"]+)"/.exec(statement);
    if (alter) add(alter[1], alter[2]);
  }
  return tables;
}

const prismaModels = parsePrismaModels(schemaSrc);
const ensured = parseEnsureSchema(STATEMENTS);

test("parsers actually found the schema (guards against a silent no-op test)", () => {
  assert.ok(prismaModels.length >= 38, `parsed only ${prismaModels.length} prisma models`);
  assert.ok(ensured.size >= 30, `parsed only ${ensured.size} tables out of ensureSchema`);
  assert.ok(Object.keys(EXPECTED_COLUMNS).length >= 30);
  // Spot-check one table end to end so a regex that matches nothing is caught.
  assert.ok(ensured.get("stripe_disputes")?.has("evidenceFinal"));
  assert.ok(prismaModels.find((m) => m.table === "bot_settings")?.columns.includes("disputeReminderDays"));
});

test("every prisma field has a column in ensureSchema (prod runs no migrations)", () => {
  const missing: string[] = [];
  for (const model of prismaModels) {
    const cols = ensured.get(model.table);
    if (!cols) {
      missing.push(`${model.table}: no CREATE TABLE in ensureSchema at all (model ${model.model})`);
      continue;
    }
    for (const column of model.columns) {
      if (!cols.has(column)) missing.push(`${model.table}.${column} (model ${model.model})`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `prisma/schema.prisma declares columns that src/db/ensureSchema.ts never creates, so a fresh or upgraded production database will not have them:\n  ${missing.join("\n  ")}`
  );
});

test("every prisma field is asserted by verifySchema", () => {
  const missing: string[] = [];
  for (const model of prismaModels) {
    const expected = EXPECTED_COLUMNS[model.table];
    if (!expected) {
      missing.push(`${model.table}: absent from EXPECTED_COLUMNS (model ${model.model})`);
      continue;
    }
    const set = new Set(expected);
    for (const column of model.columns) {
      if (!set.has(column)) missing.push(`${model.table}.${column} (model ${model.model})`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `prisma/schema.prisma declares columns that src/db/verifySchema.ts does not assert, so a forgotten ensureSchema mirror would boot silently:\n  ${missing.join("\n  ")}`
  );
});

test("verifySchema asserts nothing that prisma and ensureSchema do not have", () => {
  const byTable = new Map(prismaModels.map((m) => [m.table, new Set(m.columns)]));
  const stray: string[] = [];
  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    const prismaCols = byTable.get(table);
    const ensuredCols = ensured.get(table);
    if (!prismaCols) {
      stray.push(`${table}: asserted but no prisma model maps to it`);
      continue;
    }
    for (const column of columns) {
      if (!prismaCols.has(column)) stray.push(`${table}.${column}: asserted but not in prisma/schema.prisma`);
      else if (ensuredCols && !ensuredCols.has(column)) stray.push(`${table}.${column}: asserted but not in ensureSchema`);
    }
  }
  assert.deepEqual(stray, [], `src/db/verifySchema.ts expects columns that do not exist:\n  ${stray.join("\n  ")}`);
});

test("ensureSchema creates no column the other two do not know about", () => {
  const byTable = new Map(prismaModels.map((m) => [m.table, new Set(m.columns)]));
  const stray: string[] = [];
  for (const [table, columns] of ensured) {
    const prismaCols = byTable.get(table);
    if (!prismaCols) {
      stray.push(`${table}: created by ensureSchema but no prisma model maps to it`);
      continue;
    }
    for (const column of columns) {
      if (!prismaCols.has(column)) stray.push(`${table}.${column}: created but not declared in prisma/schema.prisma`);
    }
  }
  assert.deepEqual(stray, [], `src/db/ensureSchema.ts creates columns nothing else knows about:\n  ${stray.join("\n  ")}`);
});

test("ensureSchema is idempotent by construction: every statement is re-runnable", () => {
  // ensureSchema runs on EVERY boot, so a statement that throws the second
  // time it runs takes the whole deploy down. Three shapes are safe:
  //   - anything guarded by IF (NOT) EXISTS, including a DO $$ ... END IF block
  //   - a data backfill, which is idempotent through its own WHERE clause
  //   - DROP NOT NULL, which Postgres treats as a no-op when already nullable
  const unguarded = STATEMENTS.filter((s) => {
    const sql = s.trim();
    if (/IF\s+(NOT\s+)?EXISTS/i.test(sql)) return false;
    if (/^UPDATE\s+"/i.test(sql)) return false;
    if (/ALTER COLUMN "[^"]+" DROP NOT NULL/i.test(sql)) return false;
    return true;
  });
  assert.deepEqual(
    unguarded.map((s) => s.replace(/\s+/g, " ").slice(0, 120)),
    [],
    "every ensureSchema statement must survive being re-run on the next boot"
  );
});
