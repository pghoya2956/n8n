import type { MigrationContext, ReversibleMigration } from '../migration-types';

/**
 * Adds a nullable `lastObservedAt` column to `agents_observation_cursors`.
 *
 * Cross-thread observation scopes (`'resource'` / `'agent'`) advance the
 * cursor by message `createdAt` because the per-thread `seq` doesn't
 * linearise across threads. Thread scope continues to use `lastObservedSeq`.
 *
 * Nullable to keep the migration cheap (no backfill); pre-existing
 * thread-scoped cursors don't need the value, and future writes always
 * populate it.
 */
export class AddLastObservedAtToObservationCursors1784000000002 implements ReversibleMigration {
	async up({ schemaBuilder: { addColumns, column } }: MigrationContext) {
		await addColumns('agents_observation_cursors', [column('lastObservedAt').timestamp(3)]);
	}

	async down({ schemaBuilder: { dropColumns } }: MigrationContext) {
		await dropColumns('agents_observation_cursors', ['lastObservedAt']);
	}
}
