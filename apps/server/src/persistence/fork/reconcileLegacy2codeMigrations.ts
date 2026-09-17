import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * fork: released 2code databases (≤ 1.0.128) carried a fork-only migration
 * ledger: id 41 was `ReconcileForkMigrationCollisions` and every upstream
 * migration from 41 onwards was recorded one id later than upstream assigns
 * it. The migrator advances by numeric id, so such a database would silently
 * skip the newest upstream migration and treat the fork's shifted rows as
 * already applied. Rewrite the ledger back to upstream's numbering once; the
 * schema itself already matches because the fork replayed every colliding
 * upstream migration idempotently.
 */
export const reconcileLegacy2codeMigrationLedger = Effect.fn("reconcileLegacy2codeMigrationLedger")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (tables.length === 0) return false;

    const marker = yield* sql<{ readonly migration_id: number }>`
      SELECT migration_id FROM effect_sql_migrations
      WHERE migration_id = 41 AND name = 'ReconcileForkMigrationCollisions'
    `;
    if (marker.length === 0) return false;

    const shifted = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations
      WHERE migration_id > 41 ORDER BY migration_id ASC
    `;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 41`;
        // Ascending order keeps the primary key unique at every step.
        for (const row of shifted) {
          yield* sql`
            UPDATE effect_sql_migrations
            SET migration_id = ${row.migration_id - 1}
            WHERE migration_id = ${row.migration_id}
          `;
        }
        // The fork replayed upstream's 39/40 under its own names; align the labels.
        yield* sql`
          UPDATE effect_sql_migrations SET name = 'ProjectionProjectsDefaultThreadEnvMode'
          WHERE migration_id = 39
        `;
        yield* sql`
          UPDATE effect_sql_migrations SET name = 'ProjectionProjectFaviconPath'
          WHERE migration_id = 40
        `;
      }),
    );
    yield* Effect.log("Reconciled legacy 2code migration ledger with upstream numbering").pipe(
      Effect.annotateLogs({ shiftedRows: shifted.length }),
    );
    return true;
  },
);
