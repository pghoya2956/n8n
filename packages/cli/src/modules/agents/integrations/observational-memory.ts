import type {
	CompactFn,
	FormatContextFn,
	ModelConfig,
	NewObservation,
	ObserveFn,
	ResolveObservationalScope,
} from '@n8n/agents';
import { createModel, OBSERVATION_SCHEMA_VERSION } from '@n8n/agents';
import { Logger } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import { generateText } from 'ai';

/**
 * Encode `(agentId, resourceId)` as a single `scopeId` string for resource-
 * scoped observational memory. The SDK is consumer-agnostic about scope IDs;
 * the cli owns this encoding so the read endpoint, the write trigger, and
 * the lazy fallback all derive scopes identically.
 */
export function encodeAgentResourceScopeId(agentId: string, resourceId: string): string {
	return `${agentId}:${resourceId}`;
}

/**
 * `getScope` resolver bound to a specific agent. Use as the
 * `observationalMemory.getScope` knob on the SDK builder when configuring an
 * agent whose memory should be agent-and-user-scoped.
 *
 * Falls back to thread scope when no `resourceId` is available — that's the
 * lazy-fallback path before the consumer has plumbed resource info through,
 * so we'd rather observe under thread than skip silently.
 */
export function buildAgentResourceScopeResolver(agentId: string): ResolveObservationalScope {
	return ({ threadId, resourceId }) => {
		if (resourceId === undefined) return { scopeKind: 'thread', scopeId: threadId };
		return { scopeKind: 'resource', scopeId: encodeAgentResourceScopeId(agentId, resourceId) };
	};
}

const OBSERVER_PROMPT = `You watch a conversation between a user and an assistant and record only
BEHAVIOURAL OBSERVATIONS — patterns in how the user engages, not what they say.

A separate "working memory" already captures durable facts and current state
(user facts, preferences, goals, decisions, open follow-ups, dietary needs,
guest counts, etc.). Do NOT restate any of that. If your observation could
sit in working memory, it does not belong here — skip it.

What DOES belong here (only emit when truly present in this delta):
  - Engagement shifts (user re-engaged after a pause; user disengaged; user
    pushed back; topic-jumped; reset and resumed).
  - Recurring patterns over multiple turns (user repeatedly asks for
    directness; user keeps narrowing the same constraint; user seems fatigued).
  - Friction signals (user rejected a framing; user corrected the assistant;
    user signalled the assistant is asking too many questions).
  - Meta-preferences the user expresses about HOW they want to interact (not
    WHAT they want). Even these usually belong in working memory if durable —
    only emit if the pattern emerged across several turns rather than a single
    one-off statement.

Hard NO list (these go in working memory, not here):
  - Facts ("user has 8 guests", "dietary: 2 vegetarian, 1 GF").
  - Decisions ("decided pasta night").
  - Goals / current task / current state.
  - Single-turn statements of fact or preference.

Output format — JSON Lines, no markdown fences. Each line is one of:
  {"kind": "observation", "text": "<one-sentence behavioural observation>"}
  {"kind": "gap", "durationMs": <number>, "text": "<short note about the gap>"}

Emit nothing — output an empty response — if no behavioural pattern is
present in this delta. Most turns produce zero observations. That is the
expected case.`;

const COMPACTOR_PROMPT = `You're keeping a short, human-friendly note about how this person likes
to work — not what they're working on. Their goals, decisions, plans, and
to-dos are tracked separately in working memory; don't repeat any of that
here.

What goes in your note:
  - The way they like to be talked to (terse vs chatty, formal vs casual).
  - Patterns in how they think, ask questions, or push back.
  - Frictions you've noticed across multiple turns.

Skip:
  - Anything that sounds like a fact, decision, goal, or current task.
  - Things you'd guess from one or two messages — only patterns that have
    shown up several times count.
  - Restatements of context already obvious from the conversation.

Format: a short markdown bulleted list. Each bullet on its own line,
starting with "- " (hyphen, space). Three to six bullets is normal. No
fences, no headers, no preamble — only the list. If nothing notable has
emerged yet, return an empty string.

Keep the tone friendly and human, like notes you'd jot to remember a
collaborator's quirks. Not a clinical case study.

Example output:

- prefers terse, direct answers over a lot of back-and-forth
- often switches context after long pauses and picks up where they left off
- gets impatient when responses include a lot of explanation about what's
  happening behind the scenes`;

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
			},
		};
	};

	const formatContext: FormatContextFn = (ctx) => {
		const lines: string[] = [];
		const hasContent = ctx.summary !== null || ctx.recentObservations.length > 0;
		if (!hasContent) return '';

		lines.push('## Observed behavioural patterns');
		lines.push(
			'Patterns about HOW the user engages across this thread. Durable facts, decisions, preferences, goals, and current state are tracked separately in working memory above — do not duplicate them here, and prefer working memory when the user shares new facts or makes decisions.',
		);
		if (ctx.isStale) {
			lines.push('');
			lines.push(
				'[NOTE] These patterns are older than the configured staleness threshold — verify they still apply before relying on them.',
			);
		}
		if (ctx.summary !== null) {
			lines.push('');
			lines.push(ctx.summary);
		}
		if (ctx.recentObservations.length > 0) {
			lines.push('');
			lines.push('### Recent (uncompacted)');
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
