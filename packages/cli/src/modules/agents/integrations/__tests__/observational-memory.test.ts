import type { Observation, ObservationCursor } from '@n8n/agents';
import { OBSERVATION_SCHEMA_VERSION } from '@n8n/agents';
import { generateText } from 'ai';
import { mock } from 'jest-mock-extended';

import { createObservationalMemoryFunctions } from '../observational-memory';

jest.mock('ai', () => ({
	generateText: jest.fn(),
}));

const mockedGenerateText = generateText as jest.MockedFunction<typeof generateText>;

function buildObserveCtx(overrides: { transcript?: string; summary?: string | null } = {}) {
	return {
		deltaMessages: [
			{
				id: 'm1',
				createdAt: new Date(),
				role: 'user' as const,
				content: [{ type: 'text' as const, text: overrides.transcript ?? 'hello there' }],
			},
		],
		currentSummary: overrides.summary ?? null,
		cursor: {
			scopeKind: 'thread',
			scopeId: 't-1',
			lastObservedMessageId: 'm0',
			lastObservedAt: new Date(),
			summary: null,
			summaryUpdatedAt: null,
			updatedAt: new Date(),
		} satisfies ObservationCursor,
		scopeKind: 'thread' as const,
		scopeId: 't-1',
		telemetry: undefined,
	};
}

describe('createObservationalMemoryFunctions', () => {
	beforeEach(() => {
		mockedGenerateText.mockReset();
	});

	describe('observe', () => {
		it('returns [] for empty deltaMessages without calling the LLM', async () => {
			const { observe } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			const rows = await observe({
				...buildObserveCtx(),
				deltaMessages: [],
			});

			expect(rows).toEqual([]);
			expect(mockedGenerateText).not.toHaveBeenCalled();
		});

		it('parses well-formed JSONL output into NewObservation rows with topic+text payload', async () => {
			mockedGenerateText.mockResolvedValue({
				text: [
					'{"kind":"observation","topic":"facts","text":"Works in finance"}',
					'{"kind":"gap","topic":"patterns","durationMs":120000,"text":"Long pause"}',
				].join('\n'),
			} as never);

			const { observe } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			const rows = await observe(buildObserveCtx());

			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({
				kind: 'observation',
				payload: { topic: 'facts', text: 'Works in finance' },
				durationMs: null,
				schemaVersion: OBSERVATION_SCHEMA_VERSION,
			});
			expect(rows[1]).toMatchObject({
				kind: 'gap',
				payload: { topic: 'patterns', text: 'Long pause' },
				durationMs: 120000,
			});
		});

		it('falls back to topic="other" when the observer emits an unknown topic', async () => {
			mockedGenerateText.mockResolvedValue({
				text: '{"kind":"observation","topic":"hallucinated","text":"x"}',
			} as never);

			const { observe } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			const rows = await observe(buildObserveCtx());

			expect(rows).toHaveLength(1);
			expect(rows[0].payload).toEqual({ topic: 'other', text: 'x' });
		});

		it('skips malformed JSON lines without throwing', async () => {
			mockedGenerateText.mockResolvedValue({
				text: [
					'{"kind":"observation","topic":"facts","text":"valid"}',
					'this is not json',
					'{"missing":"fields"}',
					'{"kind":"observation","topic":"preferences","text":"also valid"}',
				].join('\n'),
			} as never);

			const { observe } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			const rows = await observe(buildObserveCtx());

			expect(rows.map((r) => (r.payload as { text: string }).text)).toEqual([
				'valid',
				'also valid',
			]);
		});

		it('includes time anchors in the observer prompt body when cursor is set', async () => {
			mockedGenerateText.mockResolvedValue({ text: '' } as never);

			const { observe } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			const lastObservedAt = new Date(Date.now() - 90 * 60 * 1000); // 90 min ago
			await observe({
				...buildObserveCtx(),
				cursor: {
					scopeKind: 'thread',
					scopeId: 't-1',
					lastObservedMessageId: 'm0',
					lastObservedAt,
					summary: null,
					summaryUpdatedAt: null,
					updatedAt: new Date(),
				},
			});

			const call = mockedGenerateText.mock.calls[0][0];
			expect(call.prompt).toContain('Time anchors:');
			expect(call.prompt).toContain('Last observed turn:');
		});

		it('omits time anchors when cursor is null', async () => {
			mockedGenerateText.mockResolvedValue({ text: '' } as never);

			const { observe } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			await observe({ ...buildObserveCtx(), cursor: null });

			const call = mockedGenerateText.mock.calls[0][0];
			expect(call.prompt).not.toContain('Time anchors:');
		});

		it('forwards experimental_telemetry when telemetry is enabled', async () => {
			mockedGenerateText.mockResolvedValue({ text: '' } as never);

			const { observe } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			await observe({
				...buildObserveCtx(),
				telemetry: {
					enabled: true,
					recordInputs: false,
					recordOutputs: false,
					integrations: [],
				},
			});

			const call = mockedGenerateText.mock.calls[0][0];
			expect(call.experimental_telemetry).toEqual({ isEnabled: true });
		});

		it('omits experimental_telemetry when telemetry is disabled', async () => {
			mockedGenerateText.mockResolvedValue({ text: '' } as never);

			const { observe } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			await observe(buildObserveCtx());

			const call = mockedGenerateText.mock.calls[0][0];
			expect(call.experimental_telemetry).toBeUndefined();
		});
	});

	describe('compact', () => {
		it('includes summary history in the compactor prompt body when getSummaryHistory returns entries', async () => {
			mockedGenerateText.mockResolvedValue({ text: '### facts\n- new\n' } as never);

			const { compact } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			await compact({
				uncompactedRows: [
					mock<Observation>({
						scopeKind: 'thread',
						scopeId: 't-1',
						kind: 'observation',
						payload: { topic: 'facts', text: 'a' },
					}),
				],
				previousSummary: 'latest profile',
				getSummaryHistory: jest.fn().mockResolvedValue(['oldest snapshot', 'middle snapshot']),
				telemetry: undefined,
			});

			const call = mockedGenerateText.mock.calls[0][0];
			expect(call.prompt).toContain('Latest profile:\nlatest profile');
			expect(call.prompt).toContain('Earlier snapshots');
			expect(call.prompt).toContain('--- snapshot 1 ---\noldest snapshot');
			expect(call.prompt).toContain('--- snapshot 2 ---\nmiddle snapshot');
		});

		it('omits the earlier-snapshots section when getSummaryHistory is empty', async () => {
			mockedGenerateText.mockResolvedValue({ text: '' } as never);

			const { compact } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			await compact({
				uncompactedRows: [
					mock<Observation>({
						scopeKind: 'thread',
						scopeId: 't-1',
						kind: 'observation',
						payload: { topic: 'facts', text: 'a' },
					}),
				],
				previousSummary: null,
				getSummaryHistory: jest.fn().mockResolvedValue([]),
				telemetry: undefined,
			});

			const call = mockedGenerateText.mock.calls[0][0];
			expect(call.prompt).not.toContain('Earlier snapshots');
		});

		it('groups observations by topic in the compactor prompt body', async () => {
			mockedGenerateText.mockResolvedValue({ text: '' } as never);

			const { compact } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			await compact({
				uncompactedRows: [
					mock<Observation>({
						kind: 'observation',
						payload: { topic: 'facts', text: 'works in finance' },
					}),
					mock<Observation>({
						kind: 'observation',
						payload: { topic: 'preferences', text: 'wants terse answers' },
					}),
					mock<Observation>({
						kind: 'observation',
						payload: { topic: 'facts', text: 'based in Berlin' },
					}),
				],
				previousSummary: null,
				getSummaryHistory: jest.fn().mockResolvedValue([]),
				telemetry: undefined,
			});

			const call = mockedGenerateText.mock.calls[0][0];
			const prompt = call.prompt as string;
			expect(prompt).toContain('### facts');
			expect(prompt).toContain('- works in finance');
			expect(prompt).toContain('- based in Berlin');
			expect(prompt).toContain('### preferences');
			expect(prompt).toContain('- wants terse answers');
			// facts heading comes before preferences in the rendering order.
			expect(prompt.indexOf('### facts')).toBeLessThan(prompt.indexOf('### preferences'));
		});

		it('returns a summary row with the trimmed text and kind=summary', async () => {
			mockedGenerateText.mockResolvedValue({ text: '   compacted output\n  ' } as never);

			const { compact } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			const result = await compact({
				uncompactedRows: [
					mock<Observation>({
						scopeKind: 'thread',
						scopeId: 't-1',
						kind: 'observation',
						payload: 'a',
					}),
				],
				previousSummary: 'old summary',
				getSummaryHistory: jest.fn().mockResolvedValue([]),
				telemetry: undefined,
			});

			expect(result.summary).toMatchObject({
				scopeKind: 'thread',
				scopeId: 't-1',
				kind: 'summary',
				payload: 'compacted output',
			});
		});
	});

	describe('formatContext', () => {
		const { formatContext } = createObservationalMemoryFunctions({
			modelConfig: 'anthropic/claude-haiku-4-5',
		});

		it('returns the empty string when summary is null and there are no recent observations', () => {
			expect(
				formatContext({
					summary: null,
					summaryUpdatedAt: null,
					isStale: false,
					recentObservations: [],
				}),
			).toBe('');
		});

		it('renders the profile section without the staleness caveat when not stale', () => {
			const out = formatContext({
				summary: 'rolling profile',
				summaryUpdatedAt: new Date(),
				isStale: false,
				recentObservations: [],
			});
			expect(out).toContain('## What I know about this user (across all our conversations)');
			expect(out).toContain('working memory');
			expect(out).toContain('rolling profile');
			expect(out).not.toContain('[NOTE]');
		});

		it('includes the staleness caveat when isStale=true', () => {
			const out = formatContext({
				summary: 'rolling profile',
				summaryUpdatedAt: new Date(0),
				isStale: true,
				recentObservations: [],
			});
			expect(out).toContain('## What I know about this user (across all our conversations)');
			expect(out).toContain('[NOTE]');
			expect(out).toContain('rolling profile');
		});

		it('renders recent observations with topic prefix when payload carries one', () => {
			const out = formatContext({
				summary: null,
				summaryUpdatedAt: null,
				isStale: false,
				recentObservations: [
					mock<Observation>({
						kind: 'observation',
						payload: { topic: 'facts', text: 'works in finance' },
					}),
					mock<Observation>({
						kind: 'gap',
						payload: { topic: 'patterns', text: 'returned after a long pause' },
					}),
					mock<Observation>({ kind: 'observation', payload: 'legacy string row' }),
				],
			});
			expect(out).toContain('### Recently observed (not yet folded into the profile)');
			expect(out).toContain('[facts] works in finance');
			expect(out).toContain('⏸ returned after a long pause');
			expect(out).toContain('• legacy string row');
		});
	});
});
