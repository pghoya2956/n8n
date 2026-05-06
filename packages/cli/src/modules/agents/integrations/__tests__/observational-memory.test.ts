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

		it('parses well-formed JSONL output into NewObservation rows', async () => {
			mockedGenerateText.mockResolvedValue({
				text: [
					'{"kind":"observation","text":"User shifted topic"}',
					'{"kind":"gap","durationMs":120000,"text":"Long pause"}',
				].join('\n'),
			} as never);

			const { observe } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			const rows = await observe(buildObserveCtx());

			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({
				kind: 'observation',
				payload: 'User shifted topic',
				durationMs: null,
				schemaVersion: OBSERVATION_SCHEMA_VERSION,
			});
			expect(rows[1]).toMatchObject({
				kind: 'gap',
				payload: 'Long pause',
				durationMs: 120000,
			});
		});

		it('skips malformed JSON lines without throwing', async () => {
			mockedGenerateText.mockResolvedValue({
				text: [
					'{"kind":"observation","text":"valid"}',
					'this is not json',
					'{"missing":"fields"}',
					'{"kind":"observation","text":"also valid"}',
				].join('\n'),
			} as never);

			const { observe } = createObservationalMemoryFunctions({
				modelConfig: 'anthropic/claude-haiku-4-5',
			});

			const rows = await observe(buildObserveCtx());

			expect(rows.map((r) => r.payload)).toEqual(['valid', 'also valid']);
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

		it('renders the patterns section without the staleness caveat when not stale', () => {
			const out = formatContext({
				summary: 'rolling state',
				summaryUpdatedAt: new Date(),
				isStale: false,
				recentObservations: [],
			});
			expect(out).toContain('## Observed behavioural patterns');
			expect(out).toContain('working memory');
			expect(out).toContain('rolling state');
			expect(out).not.toContain('[NOTE]');
		});

		it('includes the staleness caveat when isStale=true', () => {
			const out = formatContext({
				summary: 'rolling state',
				summaryUpdatedAt: new Date(0),
				isStale: true,
				recentObservations: [],
			});
			expect(out).toContain('## Observed behavioural patterns');
			expect(out).toContain('[NOTE]');
			expect(out).toContain('rolling state');
		});

		it('renders recent observations under their own section with kind-aware bullets', () => {
			const out = formatContext({
				summary: null,
				summaryUpdatedAt: null,
				isStale: false,
				recentObservations: [
					mock<Observation>({ kind: 'observation', payload: 'observed thing' }),
					mock<Observation>({ kind: 'gap', payload: 'paused for a while' }),
				],
			});
			expect(out).toContain('### Recent (uncompacted)');
			expect(out).toContain('• observed thing');
			expect(out).toContain('⏸ paused for a while');
		});
	});
});
