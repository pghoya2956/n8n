import type {
	CompactFn,
	FormatContextFn,
	ModelConfig,
	NewObservation,
	Observation,
	ObserveFn,
	ResolveObservationalScope,
} from '@n8n/agents';
import { createModel, OBSERVATION_SCHEMA_VERSION } from '@n8n/agents';
import { Logger } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import { generateText } from 'ai';

/** Closed set of topic tags the observer must pick from. */
const VALID_TOPICS = new Set([
	'facts',
	'preferences',
	'expertise',
	'patterns',
	'constraints',
	'other',
]);
type Topic = 'facts' | 'preferences' | 'expertise' | 'patterns' | 'constraints' | 'other';

/** Humanise a millisecond duration as "3h 14m" / "12m" / "45s". */
function humanizeMs(ms: number): string {
	const abs = Math.max(0, Math.floor(ms));
	const sec = Math.floor(abs / 1000);
	const min = Math.floor(sec / 60);
	const hr = Math.floor(min / 60);
	const day = Math.floor(hr / 24);
	if (day > 0) return `${day}d ${hr % 24}h`;
	if (hr > 0) return `${hr}h ${min % 60}m`;
	if (min > 0) return `${min}m`;
	return `${sec}s`;
}

/** Read the `topic` field from an observation row's JSON payload, if any. */
function topicOf(payload: unknown): Topic | undefined {
	if (typeof payload !== 'object' || payload === null) return undefined;
	const t = (payload as { topic?: unknown }).topic;
	return typeof t === 'string' && VALID_TOPICS.has(t) ? (t as Topic) : undefined;
}

/** Read the `text` field from a payload, with string-fallback for legacy rows. */
function textOf(payload: unknown): string {
	if (typeof payload === 'string') return payload;
	if (typeof payload === 'object' && payload !== null) {
		const t = (payload as { text?: unknown }).text;
		if (typeof t === 'string') return t;
	}
	return JSON.stringify(payload);
}

/** Bucket observations by topic, preserving order within each bucket. */
function groupByTopic(rows: Observation[]): Map<Topic, Observation[]> {
	const grouped = new Map<Topic, Observation[]>();
	for (const row of rows) {
		const topic = topicOf(row.payload) ?? 'other';
		const bucket = grouped.get(topic) ?? [];
		bucket.push(row);
		grouped.set(topic, bucket);
	}
	return grouped;
}

/** Render grouped observations as `### Topic\n- bullet` markdown sections. */
function renderGroupedObservations(grouped: Map<Topic, Observation[]>): string {
	const order: Topic[] = ['facts', 'preferences', 'expertise', 'patterns', 'constraints', 'other'];
	const sections: string[] = [];
	for (const topic of order) {
		const rows = grouped.get(topic);
		if (!rows || rows.length === 0) continue;
		sections.push(`### ${topic}`);
		for (const row of rows) {
			sections.push(`- ${textOf(row.payload)}`);
		}
	}
	return sections.join('\n');
}

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

const OBSERVER_PROMPT = `You're keeping notes about this user across all their conversations with
this agent. Working memory tracks per-thread state. You track CROSS-THREAD
durable observations: facts, preferences, expertise, patterns, constraints.

Your output is JSON Lines (one JSON object per line, no markdown fences).
Each line has shape:
  {"kind": "observation", "topic": "<topic>", "text": "<short note>"}
or
  {"kind": "gap", "topic": "patterns", "durationMs": <number>, "text": "<short note>"}

"topic" must be exactly one of:
  - facts        — durable facts (role, location, ongoing projects, dietary, etc.)
  - preferences  — interaction style, formats, conventions they prefer
  - expertise    — what they know well, what they're learning
  - patterns     — recurring engagement / friction / behavioural arcs
  - constraints  — recurring limitations they mention (deadlines, budget, infra)
  - other        — fallback when nothing above fits

"text" should be one short, declarative sentence the agent could read months
later and still understand without context.

When to emit a "gap" row:
  Use the "Time anchors" section in the prompt body (when present) to tell
  whether a meaningful gap has elapsed since the last observed turn. >1h is
  usually interesting; <1m is noise; in between, use judgement. Always
  include "durationMs" for gaps and pick the topic "patterns".

Quality rules:
  - Prefer durable observations over momentary ones. If you'd write the same
    note about anyone in this conversation, skip it.
  - Don't restate facts the user already wrote into working memory in the
    current turn. (Working memory is the per-thread state above the
    transcript; you don't see it here, but the agent will.) Cross-thread
    durable facts ARE in scope for you — that's the whole point of this log.
  - Don't echo the assistant's words back. Observe the USER.
  - Most turns produce zero observations. Empty output is the expected case.

Output an empty response when there's nothing durable to add. No fences,
no preamble, no commentary — only JSON Lines or nothing.`;

const COMPACTOR_PROMPT = `You produce a structured user profile across all this user's conversations
with this agent. The profile is what the agent reads to know who this person
is when a new thread starts.

You receive:
  - The latest profile (previous rolling summary).
  - Earlier profile snapshots, oldest → newest, so you can see how the
    profile has evolved.
  - Recent observations grouped by topic.

Group what you know by topic. Output is markdown:

  ### facts
  - <bullet>
  - <bullet>

  ### preferences
  - <bullet>

  ### expertise
  - <bullet>

(Only include topics that have content. Skip empty sections. 1–6 bullets
per topic is normal.)

Topics, in order:
  facts | preferences | expertise | patterns | constraints | other

Rules:
  - Carry forward what's still durable. Drop what's been superseded by newer
    observations. Add what's new and durable.
  - Each bullet should be one short, declarative sentence the agent can
    read at a glance.
  - Don't restate the conversation. Don't include per-thread state. Don't
    include momentary or single-turn observations.
  - If nothing durable has emerged across all the input, return an empty
    string.

Output: just the markdown profile (or empty). No fences, no preamble.

Example output:

### facts
- Works in finance; lead engineer on a Vue 3 migration project.
- Based in Berlin, prefers ISO timestamps.

### preferences
- Wants terse, direct answers; no preamble or recap.
- Markdown for code, plain text for prose.

### patterns
- Often pivots topic after long pauses; treats a fresh thread as a fresh start.`;

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

		const lastObservedAt = ctx.cursor?.lastObservedAt ?? null;
		const summaryUpdatedAt = ctx.cursor?.summaryUpdatedAt ?? null;
		const sinceLastTurnMs = lastObservedAt ? Date.now() - lastObservedAt.getTime() : null;
		const anchors = [
			lastObservedAt && sinceLastTurnMs !== null
				? `Last observed turn: ${lastObservedAt.toISOString()} (${humanizeMs(sinceLastTurnMs)} ago)`
				: '',
			summaryUpdatedAt ? `Last profile update: ${summaryUpdatedAt.toISOString()}` : '',
		]
			.filter(Boolean)
			.join('\n');

		const prompt = [
			ctx.currentSummary ? `Current profile:\n${ctx.currentSummary}\n` : '',
			anchors ? `Time anchors:\n${anchors}\n` : '',
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
				const parsed = JSON.parse(trimmed) as {
					kind?: string;
					topic?: string;
					text?: string;
					durationMs?: number;
				};
				if (!parsed.kind || !parsed.text) continue;
				const topic: Topic =
					parsed.topic && VALID_TOPICS.has(parsed.topic) ? (parsed.topic as Topic) : 'other';
				rows.push({
					scopeKind: ctx.scopeKind,
					scopeId: ctx.scopeId,
					kind: parsed.kind === 'gap' ? 'gap' : 'observation',
					payload: { topic, text: parsed.text },
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
		const history = await ctx.getSummaryHistory();
		const grouped = groupByTopic(ctx.uncompactedRows);

		const promptBody = [
			ctx.previousSummary ? `Latest profile:\n${ctx.previousSummary}\n` : '',
			history.length > 0
				? `Earlier snapshots (oldest → newest):\n${history
						.map((s, i) => `--- snapshot ${i + 1} ---\n${s}`)
						.join('\n')}\n`
				: '',
			`Recent observations grouped by topic:\n${renderGroupedObservations(grouped)}\n`,
			'Updated profile:',
		]
			.filter(Boolean)
			.join('\n');

		const { text } = await generateText({
			model: createModel(modelConfig),
			system: COMPACTOR_PROMPT,
			prompt: promptBody,
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

		lines.push('## What I know about this user (across all our conversations)');
		lines.push(
			'Durable cross-thread profile. Per-thread state lives in working memory above; this section is the user-level facts, preferences, expertise, and patterns observed across all their threads.',
		);
		if (ctx.isStale) {
			lines.push('');
			lines.push(
				'[NOTE] This profile is older than the configured staleness threshold — verify before relying on specific entries.',
			);
		}
		if (ctx.summary !== null) {
			lines.push('');
			lines.push(ctx.summary);
		}
		if (ctx.recentObservations.length > 0) {
			lines.push('');
			lines.push('### Recently observed (not yet folded into the profile)');
			for (const row of ctx.recentObservations) {
				const topic = topicOf(row.payload);
				const text = textOf(row.payload);
				const prefix = row.kind === 'gap' ? '⏸ ' : topic ? `[${topic}] ` : '• ';
				lines.push(`${prefix}${text}`);
			}
		}
		return lines.join('\n');
	};

	return { observe, compact, formatContext };
}
