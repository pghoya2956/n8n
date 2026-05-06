import { datetimeColumnType, WithTimestamps } from '@n8n/db';
import type { SimpleColumnType } from '@n8n/typeorm/driver/types/ColumnTypes';
import { Column, Entity, PrimaryColumn } from '@n8n/typeorm';

import type { ObservationScopeKind } from './agent-observation.entity';

@Entity({ name: 'agents_observation_cursors' })
export class AgentObservationCursorEntity extends WithTimestamps {
	@PrimaryColumn({ type: 'varchar', length: 20 })
	scopeKind: ObservationScopeKind;

	@PrimaryColumn({ type: 'varchar', length: 255 })
	scopeId: string;

	@Column({ type: 'varchar', length: 36 })
	lastObservedMessageId: string;

	@Column({ type: 'bigint' })
	lastObservedSeq: number;

	/**
	 * Wall-clock timestamp of the last observed message. Cross-thread scopes
	 * (`'resource'` / `'agent'`) advance the cursor by `createdAt` because the
	 * per-thread `seq` doesn't linearise across threads. Nullable for cursors
	 * written before this column existed.
	 */
	@Column({ type: datetimeColumnType as SimpleColumnType, nullable: true })
	lastObservedAt: Date | null;
}
