import type { MigrationContext, ReversibleMigration } from '../migration-types';

/**
 * Adds a per-thread monotonic `seq` column to `agents_messages`. Required by
 * observational memory: the cursor advance and the `getMessages({ sinceSeq })`
 * delta query both rely on it. Without `seq`, every reflect cycle re-processes
 * the entire thread transcript and `advanceCursor` throws.
 *
 * Existing rows are backfilled via `ROW_NUMBER() OVER (PARTITION BY threadId
 * ORDER BY createdAt, id)`. Both SQLite (≥3.25) and Postgres support this.
 *
 * The column is left nullable at the SQL level — making it `NOT NULL` after a
 * backfill requires a full table rebuild on SQLite and is not worth the
 * complexity. New rows are always written with a `seq` by `N8nMemory`.
 */
export class AddSeqToAgentMessages1784000000001 implements ReversibleMigration {
	async up({
		schemaBuilder: { addColumns, column },
		queryRunner,
		escape,
		runQuery,
	}: MigrationContext) {
		const table = await queryRunner.getTable(
			`${escape.tableName('').replace(/"/g, '')}agents_messages`,
		);
		const hasSeq = table?.findColumnByName('seq') !== undefined;

		if (!hasSeq) {
			await addColumns('agents_messages', [column('seq').bigint]);
		}

		const messages = escape.tableName('agents_messages');
		const seq = escape.columnName('seq');
		const id = escape.columnName('id');
		const threadId = escape.columnName('threadId');
		const createdAt = escape.columnName('createdAt');

		await runQuery(`
			UPDATE ${messages}
			SET ${seq} = sub.rn
			FROM (
				SELECT ${id} AS rid,
				       ROW_NUMBER() OVER (PARTITION BY ${threadId} ORDER BY ${createdAt}, ${id}) AS rn
				FROM ${messages}
			) AS sub
			WHERE ${messages}.${id} = sub.rid AND ${messages}.${seq} IS NULL
		`);

		await runQuery(`
			CREATE UNIQUE INDEX IF NOT EXISTS ${escape.indexName('IDX_agents_messages_threadId_seq')}
			ON ${messages} (${threadId}, ${seq})
		`);
	}

	async down({ schemaBuilder: { dropColumns }, escape, runQuery }: MigrationContext) {
		await runQuery(`DROP INDEX IF EXISTS ${escape.indexName('IDX_agents_messages_threadId_seq')}`);
		await dropColumns('agents_messages', ['seq']);
	}
}
