import type { AgentDbMessage } from './message';
import type { BuiltTelemetry } from '../telemetry';
import type { JSONValue } from '../utils/json';

/**
 * Schema version stamped onto every observation row. Bump when the row format
 * changes incompatibly. Read-side helpers filter rows newer than the running
 * SDK can interpret.
 */
export const OBSERVATION_SCHEMA_VERSION = 1;

/**
 * Scope an observation belongs to. v1 writes only `'thread'`; the others are
 * reserved so future resource- and agent-scoped observers are a behavioral
 * change, not a schema migration.
 */
export type ScopeKind = 'thread' | 'resource' | 'agent';

/** A persisted observation row. */
export interface Observation {
	id: string;
	scopeKind: ScopeKind;
	scopeId: string;
	/** Free-form, consumer-defined. The SDK reserves no values. */
	kind: string;
	payload: JSONValue;
	/** Populated for kinds that represent a time gap; otherwise `null`. */
	durationMs: number | null;
	schemaVersion: number;
	createdAt: Date;
	/** Soft-flag set by the compactor; `null` until then. */
	compactedAt: Date | null;
}

/** Shape passed to `appendObservations`. `id` is backend-assigned. */
export type NewObservation = Omit<Observation, 'id'>;

/**
 * Per-scope progress marker. The `(lastObservedAt, lastObservedMessageId)` pair
 * is a keyset cursor: `lastObservedAt` is the primary order key, with
 * `lastObservedMessageId` breaking `createdAt` ties. The same shape works for
 * thread-scoped and cross-thread scopes.
 */
export interface ObservationCursor {
	scopeKind: ScopeKind;
	scopeId: string;
	lastObservedMessageId: string;
	lastObservedAt: Date;
	updatedAt: Date;
}

export interface ObservationLockHandle {
	scopeKind: ScopeKind;
	scopeId: string;
	holderId: string;
	heldUntil: Date;
}

/**
 * Consumer-provided observer function. Called inside the orchestrator's
 * lock + cursor scope; receives the message delta since the last cursor
 * advance and the current rolling summary, returns zero or more rows to
 * append.
 */
export type ObserveFn = (ctx: {
	deltaMessages: AgentDbMessage[];
	currentSummary: string | null;
	cursor: ObservationCursor | null;
	telemetry: BuiltTelemetry | undefined;
}) => Promise<NewObservation[]>;

/**
 * Consumer-provided compactor function. Reads uncompacted rows + the previous
 * summary, returns a single new summary row to append.
 */
export type CompactFn = (ctx: {
	uncompactedRows: Observation[];
	previousSummary: string | null;
	telemetry: BuiltTelemetry | undefined;
}) => Promise<{ summary: NewObservation }>;

/**
 * Consumer-provided formatter for the system-prompt section. Receives the
 * current rolling summary, recent uncompacted observations, and a staleness
 * flag; returns the rendered section as a single string. When absent, the
 * SDK uses a minimal default formatter.
 */
export type FormatContextFn = (ctx: {
	summary: string | null;
	summaryUpdatedAt: Date | null;
	isStale: boolean;
	recentObservations: Observation[];
}) => string;

/**
 * Storage interface for observational memory. A sibling to {@link BuiltMemory}:
 * implementations typically live on the same class (cli's `N8nMemory` and the
 * SDK's `InMemoryMemory` both implement both), but the interfaces are kept
 * separate so observations stay out of the message-store API and consumers
 * don't need to feature-check every call. When `observationalMemory` is
 * configured on the builder, the configured backend must also implement this
 * interface.
 */
export interface BuiltObservationStore {
	/**
	 * Append observation rows for a scope. Backends assign `id` and return the
	 * persisted shape. Append-only; rows are not mutated after insert except
	 * via {@link BuiltObservationStore.markObservationsCompacted}.
	 */
	appendObservations(rows: NewObservation[]): Promise<Observation[]>;
	/**
	 * Query observations for a scope. Filters compose: `since`, when supplied,
	 * returns only rows strictly after the keyset `(createdAt, id) >
	 * (since.sinceCreatedAt, since.sinceObservationId)`; `kindIs` matches
	 * `kind` exactly; `onlyUncompacted` excludes rows with `compactedAt` set;
	 * `schemaVersionAtMost` excludes rows whose `schemaVersion` exceeds the
	 * caller's supported version. Results are ordered by `(createdAt, id)`
	 * ascending.
	 */
	getObservations(opts: {
		scopeKind: ScopeKind;
		scopeId: string;
		since?: { sinceCreatedAt: Date; sinceObservationId: string };
		kindIs?: string;
		limit?: number;
		schemaVersionAtMost?: number;
		onlyUncompacted?: boolean;
	}): Promise<Observation[]>;
	/**
	 * Read the message delta the observer needs to process for a given scope.
	 *
	 * - `'thread'`: messages for `scopeId` (== threadId).
	 * - `'resource'` / `'agent'`: messages across the threads belonging to the
	 *   scope. The consumer interprets `scopeId` (e.g. cli encodes
	 *   `${agentId}:${resourceId}`).
	 *
	 * When `since` is supplied, only messages strictly after the keyset
	 * `(createdAt, id) > (since.sinceCreatedAt, since.sinceMessageId)` are
	 * returned. Results are ordered by `(createdAt, id)` ascending — the last
	 * element is the most recently appended.
	 */
	getMessagesForScope(
		scopeKind: ScopeKind,
		scopeId: string,
		opts?: { since?: { sinceCreatedAt: Date; sinceMessageId: string } },
	): Promise<AgentDbMessage[]>;
	/** Soft-flag the given rows as compacted; idempotent. */
	markObservationsCompacted(ids: string[], compactedAt: Date): Promise<void>;
	/** Read the cursor for a scope; `null` if none has been written yet. */
	getCursor(scopeKind: ScopeKind, scopeId: string): Promise<ObservationCursor | null>;
	/** Upsert the cursor for a scope. */
	setCursor(cursor: ObservationCursor): Promise<void>;
	/**
	 * Acquire a per-scope advisory lock with TTL. Returns a handle on
	 * success or `null` if the lock is held by another holder and not yet
	 * expired. Holders other than `holderId` whose `heldUntil` is in the
	 * past may be displaced.
	 */
	acquireObservationLock(
		scopeKind: ScopeKind,
		scopeId: string,
		opts: { ttlMs: number; holderId: string },
	): Promise<ObservationLockHandle | null>;
	/** Release a held lock. Tolerates the lock having already expired or been displaced. */
	releaseObservationLock(handle: ObservationLockHandle): Promise<void>;
}

/**
 * Resolves the observational scope for a given persistence context. Called by
 * the runtime on the read path (system-prompt assembly), the write path
 * (`reflect` / `reflectInBackground`), and the lazy catch-up fallback.
 *
 * Consumers use this to opt their agents into `'resource'` or `'agent'` scope
 * without the SDK learning about agent IDs or user IDs. When omitted, the SDK
 * defaults to thread scope: `{ scopeKind: 'thread', scopeId: threadId }`.
 */
export type ResolveObservationalScope = (persistence: {
	threadId: string;
	resourceId?: string;
}) => { scopeKind: ScopeKind; scopeId: string };

/** Observational-memory configuration block on `MemoryConfig`. */
export interface ObservationalMemoryConfig {
	/** Builder-time default observer; `agent.reflect(observe?, ...)` can override per call. */
	observe?: ObserveFn;
	/** Builder-time default compactor. Without it, no auto-compaction runs. */
	compact?: CompactFn;
	/**
	 * Optional scope resolver. Defaults to thread scope (`scopeId === threadId`).
	 * Consumers needing resource- or agent-scoped observations supply this and
	 * encode whatever they like into `scopeId` (e.g. `${agentId}:${resourceId}`).
	 */
	getScope?: ResolveObservationalScope;
	/**
	 * When set together with `compact`, the orchestrator runs the compactor
	 * after `observe` whenever the uncompacted row count for the scope is
	 * `>=` this value.
	 */
	compactionRowThreshold?: number;
	/**
	 * When set, the formatter receives `isStale: true` once the rolling
	 * summary's `updatedAt` is older than this many milliseconds. Absent
	 * means staleness is never flagged.
	 */
	stalenessThresholdMs?: number;
	/** Consumer-provided formatter; absent means use the SDK's minimal default. */
	formatContext?: FormatContextFn;
	/**
	 * Kind value the read-side helper uses to find the rolling summary row
	 * for a scope.
	 * @default 'summary'
	 */
	summaryKind?: string;
	/**
	 * TTL applied when the orchestrator acquires the per-scope observation
	 * lock.
	 * @default 30_000
	 */
	lockTtlMs?: number;
	/**
	 * When `true`, `runObservationalCycle` calls dispatched by the SDK (e.g.
	 * lazy fallback at `TurnStart`) are awaited; otherwise they are tracked
	 * by the background-task tracker and resolve on `runtime.dispose()`.
	 * @default false
	 */
	sync?: boolean;
}
