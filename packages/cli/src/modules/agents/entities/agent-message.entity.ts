import { JsonColumn, WithTimestampsAndStringId } from '@n8n/db';
import { Column, Entity, JoinColumn, ManyToOne } from '@n8n/typeorm';

import { AgentThreadEntity } from './agent-thread.entity';

@Entity({ name: 'agents_messages' })
export class AgentMessageEntity extends WithTimestampsAndStringId {
	@Column({ type: 'varchar', length: 255 })
	threadId: string;

	@Column({ type: 'varchar', length: 255 })
	resourceId: string;

	@Column({ type: 'varchar', length: 36 })
	role: string;

	@Column({ type: 'varchar', length: 36, nullable: true })
	type: string | null;

	/**
	 * Per-thread monotonic sequence number. Backfilled from `createdAt` order
	 * for rows that pre-date the column; assigned by `N8nMemory.saveMessages`
	 * for new rows. Used by observational memory's cursor logic.
	 *
	 * Nullable in the DB to keep the migration cheap (no full table rebuild on
	 * SQLite); the application always writes a value.
	 */
	@Column({ type: 'bigint', nullable: true })
	seq: number | null;

	@JsonColumn()
	content: Record<string, unknown>;

	@ManyToOne(() => AgentThreadEntity, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'threadId' })
	thread: AgentThreadEntity;
}
