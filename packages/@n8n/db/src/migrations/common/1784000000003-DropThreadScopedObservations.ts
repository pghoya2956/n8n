import type { IrreversibleMigration, MigrationContext } from '../migration-types';

/**
 * Deletes thread-scoped observation rows after observational memory was
 * re-scoped from `(scopeKind: 'thread', scopeId: threadId)` to
 * `(scopeKind: 'resource', scopeId: ${agentId}:${resourceId})`. Old rows are
 * never read by the new code path; clearing them avoids stranded data and
 * accidental cross-scope reads. The toggle was opt-in and adoption was
 * minimal, so the data isn't load-bearing.
 *
 * Irreversible — there is no faithful inverse since no consumer rewrites
 * resource-scoped rows back to thread scope.
 */
export class DropThreadScopedObservations1784000000003 implements IrreversibleMigration {
	async up({ runQuery, escape }: MigrationContext) {
		const observations = escape.tableName('agents_observations');
		const cursors = escape.tableName('agents_observation_cursors');
		const locks = escape.tableName('agents_observation_locks');
		const scopeKind = escape.columnName('scopeKind');

		await runQuery(`DELETE FROM ${observations} WHERE ${scopeKind} = 'thread'`);
		await runQuery(`DELETE FROM ${cursors} WHERE ${scopeKind} = 'thread'`);
		await runQuery(`DELETE FROM ${locks} WHERE ${scopeKind} = 'thread'`);
	}
}
