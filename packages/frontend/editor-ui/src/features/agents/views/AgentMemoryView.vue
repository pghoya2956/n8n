<script setup lang="ts">
import { N8nButton, N8nCard, N8nSwitch, N8nText, N8nTooltip } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref, watch } from 'vue';

import { getAgentMemory, type AgentMemoryReadResponse } from '../composables/useAgentThreadsApi';
import type { AgentJsonConfig } from '../types';

const props = defineProps<{
	config: AgentJsonConfig | null;
	projectId: string;
	agentId: string;
	disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:config': [changes: Partial<AgentJsonConfig>] }>();

const i18n = useI18n();
const rootStore = useRootStore();

const memoryData = ref<AgentMemoryReadResponse | null>(null);
const loading = ref(false);
const copied = ref(false);

const observationalEnabled = computed(
	() => props.config?.memory?.observationalMemory?.enabled === true,
);
const sessionMemoryEnabled = computed(() => props.config?.memory?.enabled === true);

async function loadMemory() {
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

async function copySummary() {
	if (!memoryData.value?.summary) return;
	await navigator.clipboard.writeText(memoryData.value.summary);
	copied.value = true;
	setTimeout(() => {
		copied.value = false;
	}, 1500);
}

const formattedUpdatedAt = computed(() => {
	if (!memoryData.value?.summaryUpdatedAt) return '';
	return new Date(memoryData.value.summaryUpdatedAt).toLocaleString();
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
		if (observationalEnabled.value) void loadMemory();
		else memoryData.value = null;
	},
);

onMounted(() => {
	if (observationalEnabled.value) void loadMemory();
});
</script>

<template>
	<div :class="$style.container" data-testid="agent-memory-view">
		<N8nCard variant="outlined" :class="$style.card">
			<div :class="$style.toggleRow">
				<div :class="$style.labelGroup">
					<N8nText tag="span" size="small" :bold="true">{{
						i18n.baseText('agents.builder.memoryView.toggle.label')
					}}</N8nText>
					<N8nText size="xsmall" color="text-light">{{
						i18n.baseText('agents.builder.memoryView.toggle.hint')
					}}</N8nText>
				</div>
				<N8nSwitch
					:model-value="observationalEnabled"
					:disabled="disabled || !sessionMemoryEnabled"
					data-testid="agent-observational-memory-toggle"
					@update:model-value="onToggle"
				/>
			</div>
		</N8nCard>

		<N8nText size="small" color="text-light" :class="$style.description">
			{{ i18n.baseText('agents.builder.memoryView.description') }}
		</N8nText>

		<div v-if="memoryData?.summary" :class="$style.summarySection">
			<div :class="$style.summaryHeader">
				<N8nText tag="span" size="small" :bold="true">{{
					i18n.baseText('agents.builder.memoryView.summary.title')
				}}</N8nText>
				<div :class="$style.metaRow">
					<N8nText
						v-if="formattedUpdatedAt"
						size="xsmall"
						color="text-light"
						data-testid="agent-memory-updated"
					>
						{{
							i18n.baseText('agents.builder.memoryView.summary.updated', {
								interpolate: { time: formattedUpdatedAt },
							})
						}}
					</N8nText>
					<N8nTooltip
						:content="
							copied
								? i18n.baseText('agents.builder.addTrigger.copied')
								: i18n.baseText('agents.builder.addTrigger.copy')
						"
					>
						<N8nButton
							variant="outline"
							size="small"
							icon-only
							:icon="copied ? 'check' : 'copy'"
							:aria-label="
								copied
									? i18n.baseText('agents.builder.addTrigger.copied')
									: i18n.baseText('agents.builder.addTrigger.copy')
							"
							data-testid="agent-memory-summary-copy"
							@click="copySummary"
						/>
					</N8nTooltip>
				</div>
			</div>
			<pre :class="$style.summaryBlock" data-testid="agent-memory-summary">{{
				memoryData.summary
			}}</pre>
			<N8nText
				v-if="memoryData.observationCount > 0"
				size="xsmall"
				color="text-light"
				:class="$style.queuedNote"
			>
				{{
					i18n.baseText('agents.builder.memoryView.summary.observationsQueued', {
						adjustToNumber: memoryData.observationCount,
						interpolate: { count: String(memoryData.observationCount) },
					})
				}}
			</N8nText>
		</div>

		<div v-else-if="!loading" :class="$style.emptyState" data-testid="agent-memory-empty">
			<N8nText size="small" color="text-light">{{ emptyStateText }}</N8nText>
		</div>
	</div>
</template>

<style module lang="scss">
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
	padding: var(--spacing--lg);
	width: 100%;
	max-width: 56rem;
	margin: 0 auto;
}

.card {
	display: flex;
	flex-direction: column;
	width: 100%;
}

.toggleRow {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
	min-height: var(--spacing--xl);
}

.labelGroup {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--5xs);
	flex: 1;
	min-width: 0;
}

.description {
	padding: 0 var(--spacing--3xs);
}

.summarySection {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.summaryHeader {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
}

.metaRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.summaryBlock {
	margin: 0;
	padding: var(--spacing--sm);
	background-color: var(--color--background--light-2);
	border: var(--border);
	border-radius: var(--radius);
	font-family: var(--font-family-monospace);
	font-size: var(--font-size--sm);
	white-space: pre-wrap;
	word-break: break-word;
	line-height: var(--font-line-height--regular);
}

.queuedNote {
	padding-left: var(--spacing--3xs);
}

.emptyState {
	padding: var(--spacing--lg);
	text-align: center;
	border: 1px dashed var(--color--background--light-3);
	border-radius: var(--radius);
}
</style>
