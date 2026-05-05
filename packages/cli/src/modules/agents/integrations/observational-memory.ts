import type {
	CompactFn,
	FormatContextFn,
	ModelConfig,
	NewObservation,
	ObserveFn,
} from '@n8n/agents';
import { createModel, OBSERVATION_SCHEMA_VERSION } from '@n8n/agents';
import { Logger } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import { generateText } from 'ai';

const OBSERVER_PROMPT = `You are an observer watching a conversation between a user and an assistant.
Read the recent message delta and the current rolling summary, then emit one
JSON object per line for each NOTEWORTHY observation you make.

What counts as noteworthy:
  - Patterns or transitions (e.g. user shifted topic, frustration setting in)
  - Recurring requests or rephrasings
  - Behavioural arcs across multiple messages
Skip: factual content the assistant already captured in working memory.

Output format — JSON Lines, no markdown fences. Each line is one of:
  {"kind": "observation", "text": "<one-sentence observation>"}
  {"kind": "gap", "durationMs": <number>, "text": "<short note about the gap>"}

Emit nothing if there's nothing noteworthy. Never write the rolling summary
itself — that's the compactor's job.`;

const COMPACTOR_PROMPT = `You are a compactor. Read the previous rolling summary and a list of
recent observations, then output a NEW rolling summary that incorporates
the observations. Keep it concise — bullet-point style, drop superseded
items, preserve durable patterns. Plain text, no markdown fences.`;

const SUMMARY_KIND = 'summary';

export interface ObservationalMemoryFunctionsOptions {
	modelConfig: ModelConfig;
}

export interface ObservationalMemoryFunctions {
	observe: ObserveFn;
	compact: CompactFn;
	formatContext: FormatContextFn;
}

/**
 * Build the observe / compact / formatContext functions an agent's
 * observational-memory pipeline needs. The observer and compactor reuse the
 * agent's resolved `ModelConfig` (model id + credentials) so no extra
 * credential plumbing is required at this layer.
 *
 * Failures inside `observe` / `compact` propagate; the SDK orchestrator
 * (`runObservationalCycle`) catches them and surfaces `AgentEvent.Error`.
 */
export function createObservationalMemoryFunctions(
	opts: ObservationalMemoryFunctionsOptions,
): ObservationalMemoryFunctions {
	const { modelConfig } = opts;
	const logger = Container.get(Logger);

	const observe: ObserveFn = async (ctx) => {
		if (ctx.deltaMessages.length === 0) return [];

		const transcript = ctx.deltaMessages
			.map((m) => {
				const text =
					'content' in m && Array.isArray(m.content)
						? m.content
								.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
								.map((c) => c.text)
								.join(' ')
						: '';
				const role = 'role' in m ? m.role : 'unknown';
				return `[${role}] ${text}`;
			})
			.join('\n');

		const prompt = [
			ctx.currentSummary ? `Current rolling summary:\n${ctx.currentSummary}\n` : '',
			`Recent messages:\n${transcript}`,
		]
			.filter(Boolean)
			.join('\n');

		const { text } = await generateText({
			model: createModel(modelConfig),
			system: OBSERVER_PROMPT,
			prompt,
			experimental_telemetry: ctx.telemetry?.enabled ? { isEnabled: true } : undefined,
		});

		const rows: NewObservation[] = [];
		const now = new Date();
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as { kind?: string; text?: string; durationMs?: number };
				if (!parsed.kind || !parsed.text) continue;
				rows.push({
					scopeKind: ctx.scopeKind,
					scopeId: ctx.scopeId,
					kind: parsed.kind === 'gap' ? 'gap' : 'observation',
					payload: parsed.text,
					durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : null,
					schemaVersion: OBSERVATION_SCHEMA_VERSION,
					createdAt: now,
					compactedAt: null,
				});
			} catch {
				logger.debug('Observer emitted malformed JSON line', { line: trimmed });
			}
		}
		return rows;
	};

	const compact: CompactFn = async (ctx) => {
		const previous = ctx.previousSummary ? `Previous summary:\n${ctx.previousSummary}\n\n` : '';
		const recent = ctx.uncompactedRows
			.map((r) => `- ${typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload)}`)
			.join('\n');

		const { text } = await generateText({
			model: createModel(modelConfig),
			system: COMPACTOR_PROMPT,
			prompt: `${previous}Recent observations:\n${recent}\n\nNew rolling summary:`,
			experimental_telemetry: ctx.telemetry?.enabled ? { isEnabled: true } : undefined,
		});

		const scopeKind = ctx.uncompactedRows[0]?.scopeKind ?? 'thread';
		const scopeId = ctx.uncompactedRows[0]?.scopeId ?? '';
		return {
			summary: {
				scopeKind,
				scopeId,
				kind: SUMMARY_KIND,
				payload: text.trim(),
				durationMs: null,
				schemaVersion: OBSERVATION_SCHEMA_VERSION,
				createdAt: new Date(),
				compactedAt: null,
			},
		};
	};

	const formatContext: FormatContextFn = (ctx) => {
		const lines: string[] = [];
		if (ctx.summary !== null) {
			if (ctx.isStale) {
				lines.push(
					'[NOTE] The observational summary below is older than the configured staleness threshold — verify against current state before acting on it.',
				);
			}
			lines.push('## Observational summary');
			lines.push(ctx.summary);
		}
		if (ctx.recentObservations.length > 0) {
			lines.push('');
			lines.push('## Recent observations');
			for (const row of ctx.recentObservations) {
				const text = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
				const prefix = row.kind === 'gap' ? '⏸ ' : '• ';
				lines.push(`${prefix}${text}`);
			}
		}
		return lines.join('\n');
	};

	return { observe, compact, formatContext };
}
