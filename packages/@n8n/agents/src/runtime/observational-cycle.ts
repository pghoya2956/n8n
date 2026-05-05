import type { AgentEventBus } from './event-bus';
import { advanceCursor, getDeltaSinceCursor } from './observation-cursor';
import { withObservationLock } from './observation-lock';
import { AgentEvent } from '../types/runtime/event';
import type { BuiltMemory } from '../types/sdk/memory';
import type {
	BuiltObservationStore,
	CompactFn,
	NewObservation,
	ObservationCursor,
	ObserveFn,
	ScopeKind,
} from '../types/sdk/observation';
import type { BuiltTelemetry } from '../types/telemetry';

const DEFAULT_LOCK_TTL_MS = 30_000;

export interface RunObservationalCycleOpts {
	memory: BuiltMemory & BuiltObservationStore;
	scopeKind: ScopeKind;
	scopeId: string;
	observe: ObserveFn;
	compact?: CompactFn;
	/**
	 * Minimum number of queued (uncompacted) observations required before
	 * compaction can fire. When unset, the count gate is disabled.
	 */
	compactionMinObservations?: number;
	/**
	 * Minimum elapsed time (ms) since the last compaction before another
	 * one can fire. When unset, the idle gate is disabled. The first
	 * compaction always fires regardless (no prior `summaryUpdatedAt`).
	 */
	compactionIdleMs?: number;
	/**
	 * Burst override: when the queue grows to at least this many uncompacted
	 * observations, fire compaction even if the idle window has not elapsed.
	 * When unset, no burst override applies and the idle window is strict.
	 */
	compactionBurstThreshold?: number;
	lockTtlMs?: number;
	telemetry?: BuiltTelemetry;
	eventBus?: AgentEventBus;
}

export type RunObservationalCycleResult =
	| { status: 'skipped'; reason: 'lock-held' | 'no-delta' }
	| { status: 'ran'; observationsWritten: number; compacted: boolean };

/**
 * Run one observation cycle for a scope: acquire the lock, read the delta
 * since the cursor, invoke the consumer's `observe`, write its rows,
 * advance the cursor, and (when configured) trigger the compactor once
 * the uncompacted-row count crosses the threshold.
 *
 * Returns `'skipped'` when the lock is held by another holder or the
 * delta is empty (nothing to do). Errors from the consumer-supplied
 * `observe` and `compact` are caught and tagged via `AgentEvent.Error`;
 * the cycle does not throw, mirroring the silent-log pattern of
 * `generateThreadTitle`.
 *
 * The optional `telemetry` is forwarded to both `observe(ctx)` and
 * `compact(ctx)` so consumer LLM calls (e.g. via `generateText`) can wire
 * their `experimental_telemetry` to the same OTel tracer the main agent
 * uses. The orchestrator itself does not currently emit spans — that's a
 * future addition once we have a span shape we want to commit to.
 */
export async function runObservationalCycle(
	opts: RunObservationalCycleOpts,
): Promise<RunObservationalCycleResult> {
	const ttlMs = opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;

	const lockResult = await withObservationLock(
		opts.memory,
		opts.scopeKind,
		opts.scopeId,
		{ ttlMs },
		async () => await runInsideLock(opts),
	);

	if (lockResult.status === 'skipped') return { status: 'skipped', reason: 'lock-held' };
	return lockResult.value;
}

async function runInsideLock(
	opts: RunObservationalCycleOpts,
): Promise<RunObservationalCycleResult> {
	const { memory, scopeKind, scopeId, observe, compact, eventBus, telemetry } = opts;

	const { messages: deltaMessages, cursor } = await getDeltaSinceCursor(memory, scopeKind, scopeId);
	if (deltaMessages.length === 0) return { status: 'skipped', reason: 'no-delta' };

	// The rolling summary lives on the cursor — one row per scope, single
	// source of truth, no ordering needed.
	const previousSummary = cursor?.summary ?? null;

	let observerRows: NewObservation[];
	try {
		observerRows = await observe({
			deltaMessages,
			currentSummary: previousSummary,
			cursor,
			scopeKind,
			scopeId,
			telemetry,
		});
	} catch (error) {
		emitError(eventBus, 'observer', error);
		return { status: 'skipped', reason: 'no-delta' };
	}

	if (observerRows.length > 0) {
		await memory.appendObservations(observerRows);
		emitObservationsWritten(eventBus, scopeKind, scopeId, observerRows);
	}

	const lastMessage = deltaMessages[deltaMessages.length - 1];
	await advanceCursor(memory, scopeKind, scopeId, lastMessage);

	let compacted = false;
	if (compact) {
		try {
			compacted = await maybeCompact(opts, cursor, previousSummary);
		} catch (error) {
			emitError(eventBus, 'compactor', error);
		}
	}

	return { status: 'ran', observationsWritten: observerRows.length, compacted };
}

async function maybeCompact(
	opts: RunObservationalCycleOpts,
	cursor: ObservationCursor | null,
	previousSummary: string | null,
): Promise<boolean> {
	const { memory, scopeKind, scopeId, compact, telemetry, eventBus } = opts;
	if (!compact) return false;

	const inputs = await memory.getObservations({
		scopeKind,
		scopeId,
		onlyUncompacted: true,
	});
	if (inputs.length === 0) return false;
	if (
		opts.compactionMinObservations !== undefined &&
		inputs.length < opts.compactionMinObservations
	) {
		return false;
	}
	if (opts.compactionIdleMs !== undefined) {
		const lastSummaryAt = cursor?.summaryUpdatedAt ?? null;
		if (lastSummaryAt && Date.now() - lastSummaryAt.getTime() < opts.compactionIdleMs) {
			if (
				opts.compactionBurstThreshold === undefined ||
				inputs.length < opts.compactionBurstThreshold
			) {
				return false;
			}
		}
	}

	const result = await compact({
		uncompactedRows: inputs,
		previousSummary,
		telemetry,
	});
	const now = new Date();
	const summaryText =
		typeof result.summary.payload === 'string'
			? result.summary.payload
			: renderPayload(result.summary.payload);
	await memory.setRollingSummary(scopeKind, scopeId, summaryText, now);
	await memory.markObservationsCompacted(
		inputs.map((r) => r.id),
		now,
	);
	emitCompactionRan(eventBus, scopeKind, scopeId, inputs.length, result.summary.payload);
	return true;
}

function emitError(
	eventBus: AgentEventBus | undefined,
	source: 'observer' | 'compactor',
	error: unknown,
): void {
	if (!eventBus) return;
	const message = error instanceof Error ? error.message : String(error);
	eventBus.emit({ type: AgentEvent.Error, message, error, source });
}

function emitObservationsWritten(
	eventBus: AgentEventBus | undefined,
	scopeKind: ScopeKind,
	scopeId: string,
	rows: NewObservation[],
): void {
	if (!eventBus) return;
	const kinds = Array.from(new Set(rows.map((r) => r.kind)));
	eventBus.emit({
		type: AgentEvent.ObservationsWritten,
		scopeKind,
		scopeId,
		count: rows.length,
		kinds,
	});
}

function emitCompactionRan(
	eventBus: AgentEventBus | undefined,
	scopeKind: ScopeKind,
	scopeId: string,
	observationsCompacted: number,
	summaryPayload: unknown,
): void {
	if (!eventBus) return;
	eventBus.emit({
		type: AgentEvent.CompactionRan,
		scopeKind,
		scopeId,
		observationsCompacted,
		summary: renderPayload(summaryPayload),
	});
}

function renderPayload(payload: unknown): string {
	if (typeof payload === 'string') return payload;
	if (payload === null || payload === undefined) return '';
	try {
		return JSON.stringify(payload);
	} catch {
		return '';
	}
}
