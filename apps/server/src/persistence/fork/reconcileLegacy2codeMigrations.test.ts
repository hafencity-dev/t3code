import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import { reconcileLegacy2codeMigrationLedger } from "./reconcileLegacy2codeMigrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

interface LedgerRow {
  readonly migration_id: number;
  readonly name: string;
}

const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<LedgerRow>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
  `;
});

/** Rewrites an upstream ledger into the shape released 2code builds left behind. */
const forkifyLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<LedgerRow>`
    SELECT migration_id, name FROM effect_sql_migrations
    WHERE migration_id >= 41 ORDER BY migration_id DESC
  `;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const row of rows) {
        yield* sql`
          UPDATE effect_sql_migrations SET migration_id = ${row.migration_id + 1}
          WHERE migration_id = ${row.migration_id}
        `;
      }
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (41, 'ReconcileForkMigrationCollisions', CURRENT_TIMESTAMP)
      `;
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'ProjectionThreadSubtitles' WHERE migration_id = 39
      `;
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'RepairForkMigrationCollisions' WHERE migration_id = 40
      `;
    }),
  );
});

layer("reconcileLegacy2codeMigrationLedger", (it) => {
  it.effect("is a no-op on a database that never ran a 2code build", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 45 });
      const before = yield* readLedger;

      const changed = yield* reconcileLegacy2codeMigrationLedger();

      assert.strictEqual(changed, false);
      assert.deepStrictEqual(yield* readLedger, before);
    }),
  );

  it.effect("renumbers a released 2code ledger so newer upstream migrations still run", () =>
    Effect.gen(function* () {
      // A 2code 1.0.128 database: upstream 41..51 applied, recorded as 42..52.
      yield* runMigrations({ toMigrationInclusive: 51 });
      const upstreamLedger = yield* readLedger;
      yield* forkifyLedger;
      const forkLedger = yield* readLedger;
      assert.strictEqual(forkLedger.at(-1)?.migration_id, 52);
      assert.strictEqual(forkLedger[40]?.name, "ReconcileForkMigrationCollisions");

      // The regular startup path repairs the ledger and then applies 52 and 53.
      const executed = yield* runMigrations();

      assert.deepStrictEqual(
        executed.map(([id, name]) => `${id}_${name}`),
        ["52_ProjectionThreadTitleState", "53_PullRequestFilesViewed"],
      );
      const repaired = yield* readLedger;
      assert.deepStrictEqual(repaired.slice(0, upstreamLedger.length), upstreamLedger);
      assert.strictEqual(repaired.length, upstreamLedger.length + 2);
      assert.strictEqual(repaired.at(-1)?.name, "PullRequestFilesViewed");

      // Running again changes nothing.
      assert.strictEqual(yield* reconcileLegacy2codeMigrationLedger(), false);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});
