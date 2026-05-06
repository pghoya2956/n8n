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
		});

		if (result.status !== 'ran') throw new Error('expected status=ran');
		expect(result.compacted).toBe(true);

		// Summary lives on the cursor, not in the observations table.
		const cursor = await store.getCursor('thread', 't-1');
		expect(cursor?.summary).toBe('compacted summary');
		expect(cursor?.summaryUpdatedAt).toBeInstanceOf(Date);

		// Observation/gap rows are hard-deleted; the new summary row stays
		// behind as durable history.
		const remaining = await store.getObservations({ scopeKind: 'thread', scopeId: 't-1' });
		expect(remaining.map((r) => r.kind)).toEqual(['summary']);
		expect(remaining[0].payload).toBe('compacted summary');
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
		});

		// Compactor was given the previous summary as input on the second run.
		const compactCalls = (compact as unknown as jest.Mock).mock.calls;
		expect(compactCalls[0][0].previousSummary).toBeNull();
		expect(compactCalls[1][0].previousSummary).toBe('summary v1');

		// Cursor holds the latest; summary history accumulates as `kind: 'summary'`
		// rows in the observations table.
		const cursor = await store.getCursor('thread', 't-1');
		expect(cursor?.summary).toBe('summary v2');
		const summaryRows = await store.getObservations({
			scopeKind: 'thread',
			scopeId: 't-1',
			kindIs: 'summary',
		});
		// Both summaries persisted; ordering between them isn't asserted here
		// because back-to-back cycles can collide on millisecond timestamps.
		// The dedicated history-thunk test below uses fake timers to verify
		// oldest-first ordering.
		expect(summaryRows).toHaveLength(2);
		expect(summaryRows.map((r) => r.payload).sort()).toEqual(['summary v1', 'summary v2']);
	});

	it('compactor receives a getSummaryHistory thunk that yields prior summaries oldest-first, excluding the latest', async () => {
		jest.useFakeTimers({ doNotFake: ['nextTick'] });
		try {
			jest.setSystemTime(new Date('2026-05-05T00:00:00Z'));
			const store = new InMemoryMemory();
			await seedThread(store, 't-1', 1);

			const observe = jest.fn().mockResolvedValue([makeNewObs()]) as unknown as ObserveFn;

			// On the third cycle, capture what `getSummaryHistory()` returns.
			let capturedHistory: string[] | undefined;
			const compact = jest
				.fn()
				.mockResolvedValueOnce({ summary: makeNewObs({ kind: 'summary', payload: 's1' }) })
				.mockResolvedValueOnce({ summary: makeNewObs({ kind: 'summary', payload: 's2' }) })
				.mockImplementationOnce(async (ctx: Parameters<CompactFn>[0]) => {
					capturedHistory = await ctx.getSummaryHistory();
					return { summary: makeNewObs({ kind: 'summary', payload: 's3' }) };
				}) as unknown as CompactFn;

			// Three cycles, each separated by a minute so messages and obs have
			// distinct timestamps. Each cycle adds a fresh delta + obs pile so
			// compact fires.
			for (let i = 0; i < 3; i++) {
				jest.advanceTimersByTime(60_000);
				const t = Date.now();
				await store.saveMessages({
					threadId: 't-1',
					resourceId: 'u-1',
					messages: [
						{
							id: `m-${i}`,
							createdAt: new Date(t),
							role: 'user',
							content: [{ type: 'text', text: `q${i}` }],
						},
						{
							id: `a-${i}`,
							createdAt: new Date(t + 1),
							role: 'assistant',
							content: [{ type: 'text', text: `r${i}` }],
						},
					],
				});
				await store.appendObservations([
					makeNewObs({ payload: `obs-${i}-a`, createdAt: new Date(t + 2) }),
					makeNewObs({ payload: `obs-${i}-b`, createdAt: new Date(t + 3) }),
				]);
				await runObservationalCycle({
					memory: store,
					scopeKind: 'thread',
					scopeId: 't-1',
					observe,
					compact,
				});
			}

			// On the third cycle, prior summaries are s1 and s2; previousSummary is s2;
			// getSummaryHistory should return [s1] (oldest-first, latest dropped).
			expect((compact as unknown as jest.Mock).mock.calls).toHaveLength(3);
			expect(capturedHistory).toEqual(['s1']);
		} finally {
			jest.useRealTimers();
		}
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

	it('emits ObservationsWritten with count and unique kinds after observe', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 2);
		const bus = new AgentEventBus();
		const events: AgentEventData[] = [];
		bus.on(AgentEvent.ObservationsWritten, (e) => events.push(e));

		const observe = jest
			.fn()
			.mockResolvedValue([
				makeNewObs({ kind: 'observation' }),
				makeNewObs({ kind: 'gap' }),
				makeNewObs({ kind: 'observation' }),
			]) as unknown as ObserveFn;

		await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
			eventBus: bus,
		});

		expect(events).toHaveLength(1);
		const ev = events[0] as Extract<AgentEventData, { type: AgentEvent.ObservationsWritten }>;
		expect(ev.scopeKind).toBe('thread');
		expect(ev.scopeId).toBe('t-1');
		expect(ev.count).toBe(3);
		expect(ev.kinds.sort()).toEqual(['gap', 'observation']);
	});

	it('does not emit ObservationsWritten when observe returns no rows', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 2);
		const bus = new AgentEventBus();
		const events: AgentEventData[] = [];
		bus.on(AgentEvent.ObservationsWritten, (e) => events.push(e));

		const observe = jest.fn().mockResolvedValue([]) as unknown as ObserveFn;
		await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
			eventBus: bus,
		});

		expect(events).toHaveLength(0);
	});

	it('emits CompactionRan with summary preview when threshold crosses', async () => {
		const store = new InMemoryMemory();
		await seedThread(store, 't-1', 1);
		await store.appendObservations([
			makeNewObs({ payload: 'pre-1' }),
			makeNewObs({ payload: 'pre-2' }),
		]);
		const bus = new AgentEventBus();
		const events: AgentEventData[] = [];
		bus.on(AgentEvent.CompactionRan, (e) => events.push(e));

		const observe = jest
			.fn()
			.mockResolvedValue([makeNewObs({ payload: 'fresh' })]) as unknown as ObserveFn;
		const longSummary = 'x'.repeat(200);
		const compact = jest.fn().mockResolvedValue({
			summary: makeNewObs({ kind: 'summary', payload: longSummary }),
		}) as unknown as CompactFn;

		await runObservationalCycle({
			memory: store,
			scopeKind: 'thread',
			scopeId: 't-1',
			observe,
			compact,
			eventBus: bus,
		});

		expect(events).toHaveLength(1);
		const ev = events[0] as Extract<AgentEventData, { type: AgentEvent.CompactionRan }>;
		expect(ev.scopeKind).toBe('thread');
		expect(ev.scopeId).toBe('t-1');
		expect(ev.observationsCompacted).toBe(3);
		expect(ev.summary).toBe(longSummary);
	});

	describe('compactionIdleMs gate', () => {
		beforeEach(() => {
			jest.useFakeTimers({ doNotFake: ['nextTick'] });
		});
		afterEach(() => {
			jest.useRealTimers();
		});

		it('first compaction fires regardless of idle window (no prior summaryUpdatedAt)', async () => {
			jest.setSystemTime(new Date('2026-05-05T00:00:00Z'));
			const store = new InMemoryMemory();
			await seedThread(store, 't-1', 1);
			await store.appendObservations([makeNewObs(), makeNewObs()]);

			const observe = jest.fn().mockResolvedValue([makeNewObs()]) as unknown as ObserveFn;
			const compact = jest.fn().mockResolvedValue({
				summary: makeNewObs({ kind: 'summary', payload: 'first summary' }),
			}) as unknown as CompactFn;

			const result = await runObservationalCycle({
				memory: store,
				scopeKind: 'thread',
				scopeId: 't-1',
				observe,
				compact,
				compactionIdleMs: 5 * 60 * 1000,
			});

			if (result.status !== 'ran') throw new Error('expected status=ran');
			expect(result.compacted).toBe(true);
			expect(compact).toHaveBeenCalledTimes(1);
		});

		it('skips a second compaction within the idle window', async () => {
			jest.setSystemTime(new Date('2026-05-05T00:00:00Z'));
			const store = new InMemoryMemory();
			await seedThread(store, 't-1', 1);
			await store.appendObservations([makeNewObs(), makeNewObs()]);

			const observe = jest.fn().mockResolvedValue([makeNewObs()]) as unknown as ObserveFn;
			const compact = jest.fn().mockResolvedValue({
				summary: makeNewObs({ kind: 'summary', payload: 'summary' }),
			}) as unknown as CompactFn;

			// First cycle: fires.
			await runObservationalCycle({
				memory: store,
				scopeKind: 'thread',
				scopeId: 't-1',
				observe,
				compact,
				compactionIdleMs: 5 * 60 * 1000,
			});
			expect(compact).toHaveBeenCalledTimes(1);

			// Advance only 1 minute and queue more observations.
			jest.advanceTimersByTime(60 * 1000);
			await store.saveMessages({
				threadId: 't-1',
				resourceId: 'u-1',
				messages: [makeMsg('user', 'next-1'), makeMsg('assistant', 'next-2')],
			});
			await store.appendObservations([
				makeNewObs({ payload: 'b1', createdAt: new Date() }),
				makeNewObs({ payload: 'b2', createdAt: new Date() }),
				makeNewObs({ payload: 'b3', createdAt: new Date() }),
			]);

			// Second cycle within window: skipped.
			const result = await runObservationalCycle({
				memory: store,
				scopeKind: 'thread',
				scopeId: 't-1',
				observe,
				compact,
				compactionIdleMs: 5 * 60 * 1000,
			});

			if (result.status !== 'ran') throw new Error('expected status=ran');
			expect(result.compacted).toBe(false);
			expect(compact).toHaveBeenCalledTimes(1);
		});

		it('burst override fires within the idle window when queue >= burst threshold', async () => {
			jest.setSystemTime(new Date('2026-05-05T00:00:00Z'));
			const store = new InMemoryMemory();
			await seedThread(store, 't-1', 1);
			await store.appendObservations([makeNewObs(), makeNewObs()]);

			const observe = jest.fn().mockResolvedValue([makeNewObs()]) as unknown as ObserveFn;
			const compact = jest.fn().mockResolvedValue({
				summary: makeNewObs({ kind: 'summary', payload: 'summary' }),
			}) as unknown as CompactFn;

			// First cycle: fires (no prior summary).
			await runObservationalCycle({
				memory: store,
				scopeKind: 'thread',
				scopeId: 't-1',
				observe,
				compact,
				compactionIdleMs: 5 * 60 * 1000,
				compactionBurstThreshold: 5,
			});
			expect(compact).toHaveBeenCalledTimes(1);

			// Within window, queue grows to >= burst threshold.
			jest.advanceTimersByTime(60 * 1000);
			await store.saveMessages({
				threadId: 't-1',
				resourceId: 'u-1',
				messages: [makeMsg('user', 'next-1'), makeMsg('assistant', 'next-2')],
			});
			await store.appendObservations([
				makeNewObs({ payload: 'b1', createdAt: new Date() }),
				makeNewObs({ payload: 'b2', createdAt: new Date() }),
				makeNewObs({ payload: 'b3', createdAt: new Date() }),
				makeNewObs({ payload: 'b4', createdAt: new Date() }),
				makeNewObs({ payload: 'b5', createdAt: new Date() }),
			]);

			const result = await runObservationalCycle({
				memory: store,
				scopeKind: 'thread',
				scopeId: 't-1',
				observe,
				compact,
				compactionIdleMs: 5 * 60 * 1000,
				compactionBurstThreshold: 5,
			});

			if (result.status !== 'ran') throw new Error('expected status=ran');
			expect(result.compacted).toBe(true);
			expect(compact).toHaveBeenCalledTimes(2);
		});

		it('burst override does not apply when queue stays below the burst threshold', async () => {
			jest.setSystemTime(new Date('2026-05-05T00:00:00Z'));
			const store = new InMemoryMemory();
			await seedThread(store, 't-1', 1);
			await store.appendObservations([makeNewObs(), makeNewObs()]);

			const observe = jest.fn().mockResolvedValue([makeNewObs()]) as unknown as ObserveFn;
			const compact = jest.fn().mockResolvedValue({
				summary: makeNewObs({ kind: 'summary', payload: 'summary' }),
			}) as unknown as CompactFn;

			await runObservationalCycle({
				memory: store,
				scopeKind: 'thread',
				scopeId: 't-1',
				observe,
				compact,
				compactionIdleMs: 5 * 60 * 1000,
				compactionBurstThreshold: 10,
			});
			expect(compact).toHaveBeenCalledTimes(1);

			jest.advanceTimersByTime(60 * 1000);
			await store.saveMessages({
				threadId: 't-1',
				resourceId: 'u-1',
				messages: [makeMsg('user', 'next-1'), makeMsg('assistant', 'next-2')],
			});
			// Only 4 new observations — well below burst threshold of 10.
			await store.appendObservations([
				makeNewObs({ payload: 'b1', createdAt: new Date() }),
				makeNewObs({ payload: 'b2', createdAt: new Date() }),
				makeNewObs({ payload: 'b3', createdAt: new Date() }),
				makeNewObs({ payload: 'b4', createdAt: new Date() }),
			]);

			const result = await runObservationalCycle({
				memory: store,
				scopeKind: 'thread',
				scopeId: 't-1',
				observe,
				compact,
				compactionIdleMs: 5 * 60 * 1000,
				compactionBurstThreshold: 10,
			});

			if (result.status !== 'ran') throw new Error('expected status=ran');
			expect(result.compacted).toBe(false);
			expect(compact).toHaveBeenCalledTimes(1);
		});

		it('fires again once the idle window has elapsed', async () => {
			jest.setSystemTime(new Date('2026-05-05T00:00:00Z'));
			const store = new InMemoryMemory();
			await seedThread(store, 't-1', 1);
			await store.appendObservations([makeNewObs(), makeNewObs()]);

			const observe = jest.fn().mockResolvedValue([makeNewObs()]) as unknown as ObserveFn;
			const compact = jest.fn().mockResolvedValue({
				summary: makeNewObs({ kind: 'summary', payload: 'summary' }),
			}) as unknown as CompactFn;

			await runObservationalCycle({
				memory: store,
				scopeKind: 'thread',
				scopeId: 't-1',
				observe,
				compact,
				compactionIdleMs: 5 * 60 * 1000,
			});
			expect(compact).toHaveBeenCalledTimes(1);

			jest.advanceTimersByTime(6 * 60 * 1000);
			await store.saveMessages({
				threadId: 't-1',
				resourceId: 'u-1',
				messages: [makeMsg('user', 'next-1'), makeMsg('assistant', 'next-2')],
			});
			await store.appendObservations([
				makeNewObs({ payload: 'b1', createdAt: new Date() }),
				makeNewObs({ payload: 'b2', createdAt: new Date() }),
				makeNewObs({ payload: 'b3', createdAt: new Date() }),
			]);

			const result = await runObservationalCycle({
				memory: store,
				scopeKind: 'thread',
				scopeId: 't-1',
				observe,
				compact,
				compactionIdleMs: 5 * 60 * 1000,
			});

			if (result.status !== 'ran') throw new Error('expected status=ran');
			expect(result.compacted).toBe(true);
			expect(compact).toHaveBeenCalledTimes(2);
		});
	});
});
