<script setup lang="ts">
import { N8nSwitch, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { getAgentMemory, type AgentMemoryReadResponse } from '../composables/useAgentThreadsApi';
import type { AgentJsonConfig } from '../types';
import AgentMiniEditor from '../components/AgentMiniEditor.vue';

/**
 * How often to poll the rolling summary while the panel is mounted and
 * observational memory is enabled. Memory only changes after an observe/compact
 * cycle (post-turn), so a few seconds of latency is fine.
 */
const REFRESH_INTERVAL_MS = 5000;

// Mirror of cli/from-json-config defaults — kept here only for the debug
// countdown below. If those defaults change, this display drifts.
const COMPACTION_IDLE_WINDOW_MS = 5 * 60 * 1000;
const COMPACTION_MIN_OBSERVATIONS = 3;
const COMPACTION_BURST_THRESHOLD = 10;
const COUNTDOWN_TICK_MS = 1000;

const props = withDefaults(
	defineProps<{
		config: AgentJsonConfig | null;
		projectId: string;
		agentId: string;
		disabled?: boolean;
	}>(),
	{
		disabled: false,
	},
);

const emit = defineEmits<{ 'update:config': [changes: Partial<AgentJsonConfig>] }>();

const i18n = useI18n();
const rootStore = useRootStore();

const memoryData = ref<AgentMemoryReadResponse | null>(null);
const loading = ref(false);
const now = ref(Date.now());

const observationalEnabled = computed(
	() => props.config?.memory?.observationalMemory?.enabled === true,
);
const sessionMemoryEnabled = computed(() => props.config?.memory?.enabled === true);

async function loadMemory() {
	if (loading.value) return;
	loading.value = true;
	try {
		memoryData.value = await getAgentMemory(
			rootStore.restApiContext,
			props.projectId,
			props.agentId,
		);
	} finally {
		loading.value = false;
	}
}

let refreshHandle: ReturnType<typeof setInterval> | null = null;
let tickHandle: ReturnType<typeof setInterval> | null = null;

function startAutoRefresh() {
	stopAutoRefresh();
	refreshHandle = setInterval(() => {
		if (document.visibilityState !== 'visible') return;
		if (!observationalEnabled.value) return;
		void loadMemory();
	}, REFRESH_INTERVAL_MS);
	tickHandle = setInterval(() => {
		now.value = Date.now();
	}, COUNTDOWN_TICK_MS);
}

function stopAutoRefresh() {
	if (refreshHandle !== null) {
		clearInterval(refreshHandle);
		refreshHandle = null;
	}
	if (tickHandle !== null) {
		clearInterval(tickHandle);
		tickHandle = null;
	}
}

function onToggle(enabled: boolean) {
	if (!props.config?.memory?.enabled) return;
	emit('update:config', {
		memory: {
			...props.config.memory,
			observationalMemory: {
				...(props.config.memory.observationalMemory ?? {}),
				enabled,
			},
		},
	});
}

const formattedUpdatedAt = computed(() => {
	if (!memoryData.value?.summaryUpdatedAt) return '';
	return new Date(memoryData.value.summaryUpdatedAt).toLocaleString();
});

const debugCountdown = computed(() => {
	if (!observationalEnabled.value) return '';
	const queued = memoryData.value?.observationCount ?? 0;
	const updatedAtMs = memoryData.value?.summaryUpdatedAt
		? new Date(memoryData.value.summaryUpdatedAt).getTime()
		: null;
	const queuedSuffix = `${queued} queued (≥${COMPACTION_MIN_OBSERVATIONS} floor, ≥${COMPACTION_BURST_THRESHOLD} burst)`;

	if (queued < COMPACTION_MIN_OBSERVATIONS) {
		return `[debug] below floor — ${queuedSuffix}`;
	}
	if (queued >= COMPACTION_BURST_THRESHOLD) {
		return `[debug] burst override — fires next turn — ${queuedSuffix}`;
	}
	if (updatedAtMs === null) {
		return `[debug] no prior compaction — fires next turn — ${queuedSuffix}`;
	}
	const nextAt = updatedAtMs + COMPACTION_IDLE_WINDOW_MS;
	const remainingMs = nextAt - now.value;
	if (remainingMs <= 0) {
		return `[debug] idle window elapsed — fires next turn — ${queuedSuffix}`;
	}
	const totalSec = Math.ceil(remainingMs / 1000);
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `[debug] idle window: ${m}m ${String(s).padStart(2, '0')}s left — ${queuedSuffix}`;
});

const emptyStateText = computed(() => {
	if (!observationalEnabled.value) return i18n.baseText('agents.builder.memoryView.empty.disabled');
	if (memoryData.value && memoryData.value.observationCount > 0) {
		return i18n.baseText('agents.builder.memoryView.empty.noSummary');
	}
	return i18n.baseText('agents.builder.memoryView.empty.noObservations');
});

watch(
	() => [props.projectId, props.agentId, observationalEnabled.value],
	() => {
		if (observationalEnabled.value) {
			void loadMemory();
			startAutoRefresh();
		} else {
			memoryData.value = null;
			stopAutoRefresh();
		}
	},
);

onMounted(() => {
	if (observationalEnabled.value) {
		void loadMemory();
		startAutoRefresh();
	}
});

onBeforeUnmount(() => {
	stopAutoRefresh();
});
</script>

<template>
	<div
		:class="[$style.container, props.disabled && $style.disabled]"
		:inert="props.disabled || undefined"
		data-testid="agent-memory-view"
	>
		<div :class="$style.titleGroup">
			<div :class="$style.header">
				<N8nText tag="h3" :bold="true">{{
					i18n.baseText('agents.builder.memoryView.title')
				}}</N8nText>
				<N8nSwitch
					:model-value="observationalEnabled"
					:disabled="disabled || !sessionMemoryEnabled"
					data-testid="agent-observational-memory-toggle"
					@update:model-value="onToggle"
				/>
			</div>
			<N8nText size="small" color="text-light">
				{{ i18n.baseText('agents.builder.memoryView.description') }}
			</N8nText>
		</div>

		<template v-if="observationalEnabled">
			<div v-if="memoryData?.summary" :class="$style.summarySection">
				<AgentMiniEditor
					:model-value="memoryData.summary"
					language="markdown"
					readonly
					min-height="120px"
					max-height="320px"
					data-testid="agent-memory-summary"
				/>
				<div :class="$style.metaFooter">
					<N8nText v-if="memoryData.observationCount > 0" size="xsmall" color="text-light">
						{{
							i18n.baseText('agents.builder.memoryView.summary.observationsQueued', {
								adjustToNumber: memoryData.observationCount,
								interpolate: { count: String(memoryData.observationCount) },
							})
						}}
					</N8nText>
					<N8nText
						v-if="formattedUpdatedAt"
						size="xsmall"
						color="text-light"
						:class="$style.metaUpdated"
						data-testid="agent-memory-updated"
					>
						{{
							i18n.baseText('agents.builder.memoryView.summary.updated', {
								interpolate: { time: formattedUpdatedAt },
							})
						}}
					</N8nText>
				</div>
			</div>

			<div v-else-if="!loading" :class="$style.emptyState" data-testid="agent-memory-empty">
				<N8nText size="small" color="text-light">{{ emptyStateText }}</N8nText>
			</div>

			<div :class="$style.debugCountdown" data-testid="agent-memory-debug-countdown">
				<N8nText size="xsmall" color="text-light" :class="$style.debugMono">{{
					debugCountdown
				}}</N8nText>
			</div>
		</template>
	</div>
</template>

<style module lang="scss">
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	width: 100%;
}

.titleGroup {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
}

/* Mirrors AgentMemoryPanel: title group stays interactive while body is dimmed when disabled. */
.container.disabled > :not(.titleGroup) {
	pointer-events: none;
	opacity: 0.6;
}

.summarySection {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.metaFooter {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
	padding: 0 var(--spacing--3xs);
}

.metaUpdated {
	margin-left: auto;
}

.emptyState {
	padding: var(--spacing--lg);
	text-align: center;
	border: 1px dashed var(--color--background--light-3);
	border-radius: var(--radius);
}

.debugCountdown {
	padding: var(--spacing--3xs) var(--spacing--3xs);
	border-top: 1px dashed var(--color--background--light-3);
}

.debugMono {
	font-family: var(--font-family--monospace);
}
</style>
