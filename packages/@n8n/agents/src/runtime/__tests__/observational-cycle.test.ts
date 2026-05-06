import { AgentEvent, type AgentEventData } from '../../types/runtime/event';
import type { AgentDbMessage } from '../../types/sdk/message';
import {
	OBSERVATION_SCHEMA_VERSION,
	type CompactFn,
	type NewObservation,
	type ObserveFn,
} from '../../types/sdk/observation';
import { AgentEventBus } from '../event-bus';
import { InMemoryMemory } from '../memory-store';
import { runObservationalCycle } from '../observational-cycle';

function makeMsg(role: 'user' | 'assistant', text: string): AgentDbMessage {
	return {
		id: crypto.randomUUID(),
		createdAt: new Date(),
		role,
		content: [{ type: 'text', text }],
	};
}

function makeNewObs(overrides: Partial<NewObservation> = {}): NewObservation {
	return {
		scopeKind: 'thread',
		scopeId: 't-1',
		kind: 'observation',
		payload: 'an observation',
		durationMs: null,
		schemaVersion: OBSERVATION_SCHEMA_VERSION,
		createdAt: new Date('2026-05-05T00:00:00Z'),
		compactedAt: null,
		...overrides,
	};
}

async function seedThread(store: InMemoryMemory, threadId: string, count: number): Promise<void> {
	await store.saveThread({ id: threadId, resourceId: 'u-1' });
	const messages: AgentDbMessage[] = [];
	for (let i = 0; i < count; i++) {
		messages.push(makeMsg(i % 2 === 0 ? 'user' : 'assistant', `m-${i}`));
	}
	await store.saveMessages({ threadId, resourceId: 'u-1', messages });
}

describe('runObservationalCycle', () => {
	it('skips with lock-held when another holder is on the lock', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 1);
		await store.acquireObservationLock('thread', 't-1', { ttlMs: 60_000, holderId: 'other' });

		const observe: ObserveFn = jest.fn().mockResolvedValue([]) as unknown as ObserveFn;
		const result = await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
		});

		expect(result).toEqual({ status: 'skipped', reason: 'lock-held' });
		expect(observe).not.toHaveBeenCalled();
	});

	it('skips with no-delta when there are no new messages since the cursor', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 2);
		const messages = await store.getMessages('t-1');
		await store.setCursor({
			scopeKind: 'thread',
			scopeId: 't-1',
			lastObservedMessageId: messages[messages.length - 1].id,
			lastObservedAt: messages[messages.length - 1].createdAt,
			summary: null,
			summaryUpdatedAt: null,
			updatedAt: new Date(),
		});

		const observe: ObserveFn = jest.fn().mockResolvedValue([]) as unknown as ObserveFn;
		const result = await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
		});

		expect(result).toEqual({ status: 'skipped', reason: 'no-delta' });
		expect(observe).not.toHaveBeenCalled();
	});

	it('writes observations and advances the cursor for a fresh thread', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 2);

		const observe: ObserveFn = jest
			.fn()
			.mockResolvedValue([makeNewObs({ payload: 'first obs' })]) as unknown as ObserveFn;

		const result = await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
		});

		expect(result).toEqual({ status: 'ran', observationsWritten: 1, compacted: false });

		const written = await store.getObservations({ scopeKind: 'thread', scopeId: 't-1' });
		expect(written.map((r) => r.payload)).toEqual(['first obs']);

		const messages = await store.getMessages('t-1');
		const cursor = await store.getCursor('thread', 't-1');
		expect(cursor?.lastObservedMessageId).toBe(messages[messages.length - 1].id);
		expect(cursor?.lastObservedAt.getTime()).toBe(
			messages[messages.length - 1].createdAt.getTime(),
		);
	});

	it('reads the previous summary from the cursor and passes it into observe', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 2);
		// Seed a cursor row with a rolling summary, mirroring what a previous
		// compaction would have written via setRollingSummary.
		await store.setRollingSummary('thread', 't-1', 'rolling state', new Date());

		const observe = jest
			.fn<Promise<NewObservation[]>, [Parameters<ObserveFn>[0]]>()
			.mockResolvedValue([]);

		await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe: observe as unknown as ObserveFn,
		});

		expect(observe).toHaveBeenCalledTimes(1);
		const arg = observe.mock.calls[0][0];
		expect(arg.currentSummary).toBe('rolling state');
		expect(arg.cursor?.summary).toBe('rolling state');
		expect(arg.deltaMessages.length).toBe(2);
	});

	it('catches observe() errors, emits AgentEvent.Error tagged observer, does not advance cursor', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 2);
		const bus = new AgentEventBus();
		const errorEvents: AgentEventData[] = [];
		bus.on(AgentEvent.Error, (e) => errorEvents.push(e));

		const observe = (() => {
			throw new Error('observer failed');
		}) as ObserveFn;

		const result = await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
			eventBus: bus,
		});

		expect(result.status).toBe('skipped');
		expect(errorEvents).toHaveLength(1);
		const event = errorEvents[0] as Extract<AgentEventData, { type: AgentEvent.Error }>;
		expect(event.source).toBe('observer');
		expect(event.message).toContain('observer failed');

		// Cursor must not advance — the next cycle should reprocess the same delta.
		const cursor = await store.getCursor('thread', 't-1');
		expect(cursor).toBeNull();
	});

	it('does not call compact when threshold is not crossed', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 1);

		const observe = jest.fn().mockResolvedValue([makeNewObs()]) as unknown as ObserveFn;
		const compact = jest.fn() as unknown as CompactFn;

		const result = await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
			compact,
			compactionRowThreshold: 5,
		});

		expect(result).toEqual({ status: 'ran', observationsWritten: 1, compacted: false });
		expect(compact).not.toHaveBeenCalled();
	});

	it('runs compact when threshold crossed: writes summary to cursor, flags inputs as compacted', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 1);
		// Pre-seed observations so the threshold is reached after observe writes.
		await store.appendObservations([
			makeNewObs({ payload: 'pre-1' }),
			makeNewObs({ payload: 'pre-2' }),
		]);

		const observe = jest
			.fn()
			.mockResolvedValue([makeNewObs({ payload: 'fresh' })]) as unknown as ObserveFn;

		const compact = jest.fn().mockResolvedValue({
			summary: makeNewObs({ kind: 'summary', payload: 'compacted summary' }),
		}) as unknown as CompactFn;

		const result = await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
			compact,
			compactionRowThreshold: 3,
		});

		if (result.status !== 'ran') throw new Error('expected status=ran');
		expect(result.compacted).toBe(true);

		// Summary lives on the cursor, not in the observations table.
		const cursor = await store.getCursor('thread', 't-1');
		expect(cursor?.summary).toBe('compacted summary');
		expect(cursor?.summaryUpdatedAt).toBeInstanceOf(Date);

		const allObs = await store.getObservations({ scopeKind: 'thread', scopeId: 't-1' });
		expect(allObs.every((r) => r.kind === 'observation')).toBe(true);

		// All input observations got flagged as compacted.
		const uncompacted = await store.getObservations({
			scopeKind: 'thread',
			scopeId: 't-1',
			onlyUncompacted: true,
		});
		expect(uncompacted).toHaveLength(0);
	});

	it('compacting a second time replaces the rolling summary on the cursor', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 1);
		await store.appendObservations([makeNewObs(), makeNewObs()]);

		const observe = jest.fn().mockResolvedValue([makeNewObs()]) as unknown as ObserveFn;

		const compact = jest
			.fn()
			.mockResolvedValueOnce({ summary: makeNewObs({ kind: 'summary', payload: 'summary v1' }) })
			.mockResolvedValueOnce({
				summary: makeNewObs({ kind: 'summary', payload: 'summary v2' }),
			}) as unknown as CompactFn;

		await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
			compact,
			compactionRowThreshold: 3,
		});

		// Reset thread for a second cycle: append more messages + observations.
		const t2 = Date.now();
		await store.saveMessages({
			threadId: 't-1',
			resourceId: 'u-1',
			messages: [makeMsg('user', 'next-1'), makeMsg('assistant', 'next-2')],
		});
		await store.appendObservations([
			makeNewObs({ payload: 'second-1', createdAt: new Date(t2) }),
			makeNewObs({ payload: 'second-2', createdAt: new Date(t2 + 1) }),
		]);

		await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
			compact,
			compactionRowThreshold: 3,
		});

		// Compactor was given the previous summary as input on the second run.
		const compactCalls = (compact as unknown as jest.Mock).mock.calls;
		expect(compactCalls[0][0].previousSummary).toBeNull();
		expect(compactCalls[1][0].previousSummary).toBe('summary v1');

		// Cursor now holds only the latest summary — no accumulating rows.
		const cursor = await store.getCursor('thread', 't-1');
		expect(cursor?.summary).toBe('summary v2');
	});

	it('catches compact() errors and emits AgentEvent.Error tagged compactor (still returns ran)', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 1);
		await store.appendObservations([makeNewObs(), makeNewObs(), makeNewObs()]);

		const observe = jest.fn().mockResolvedValue([makeNewObs()]) as unknown as ObserveFn;
		const compact = jest
			.fn()
			.mockRejectedValue(new Error('compact failed')) as unknown as CompactFn;

		const bus = new AgentEventBus();
		const errorEvents: AgentEventData[] = [];
		bus.on(AgentEvent.Error, (e) => errorEvents.push(e));

		const result = await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
			compact,
			compactionRowThreshold: 1,
			eventBus: bus,
		});

		// Observer wrote successfully, so the cycle is 'ran'; compactor failure
		// is reported but doesn't unwind the observe step.
		expect(result.status).toBe('ran');
		expect(errorEvents).toHaveLength(1);
		const event = errorEvents[0] as Extract<AgentEventData, { type: AgentEvent.Error }>;
		expect(event.source).toBe('compactor');
	});

	it('forwards the telemetry handle to observe() and compact()', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 1);
		await store.appendObservations([makeNewObs(), makeNewObs()]);

		const observe = jest
			.fn<Promise<NewObservation[]>, [Parameters<ObserveFn>[0]]>()
			.mockResolvedValue([makeNewObs()]);
		const compact = jest
			.fn<Promise<{ summary: NewObservation }>, [Parameters<CompactFn>[0]]>()
			.mockResolvedValue({ summary: makeNewObs({ kind: 'summary' }) });

		const telemetry = {
			enabled: true,
			recordInputs: false,
			recordOutputs: false,
			integrations: [],
		};

		await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe: observe as unknown as ObserveFn,
			compact: compact as unknown as CompactFn,
			compactionRowThreshold: 1,
			telemetry,
		});

		expect(observe.mock.calls[0][0].telemetry).toBe(telemetry);
		expect(compact.mock.calls[0][0].telemetry).toBe(telemetry);
	});

	it('releases the lock so a subsequent cycle can run', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 1);

		const observe = jest.fn().mockResolvedValue([]) as unknown as ObserveFn;
		await runObservationalCycle({ memory: store, scopeKind: 'thread', scopeId: 't-1', observe });

		// Second call should not be blocked by a stale lock.
		const second = await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
		});
		// Cursor advanced after first run, so second run sees no delta.
		expect(second).toEqual({ status: 'skipped', reason: 'no-delta' });
	});
});
