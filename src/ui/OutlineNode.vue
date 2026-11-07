<script setup lang="ts">
import { computed } from "vue";
import { folds, isOpen, listForFold, openPanel, reveal, setFocus, state, toggle } from "../state/store";

const props = defineProps<{ id: string; depth: number; expanded: Set<string> }>();
const emit = defineEmits<{ (e: "toggle", id: string): void }>();

const f = computed(() => folds.value[props.id]);
const kids = computed(() => f.value?.children ?? []);
const isExpanded = computed(() => props.expanded.has(props.id));
const ICON: Record<string, string> = { cte: "W", derived: "F", subquery: "S", branch: "U", columns: "≡" };

function onClick() {
  reveal(props.id);
  if (f.value.kind === "columns" && !isOpen(props.id)) toggle(props.id);
}
function onDbl() {
  if (f.value.kind === "columns") openPanel(listForFold(props.id) ?? null);
  else setFocus(props.id);
}
</script>

<template>
  <li v-if="f">
    <div
      class="node"
      :class="{ focus: state.focus === id, cur: state.cursor === id, panel: f.kind === 'columns' && listForFold(id) === state.panel }"
      :style="{ paddingLeft: depth * 12 + 4 + 'px' }"
      :title="`${f.name} (${f.kind})\nClick: show · Double-click: focus`"
      @click="onClick"
      @dblclick="onDbl"
    >
      <button v-if="kids.length" class="tw" @click.stop="emit('toggle', id)">{{ isExpanded ? "▾" : "▸" }}</button>
      <span v-else class="tw" />
      <span class="icon" :class="f.kind">{{ ICON[f.kind] }}</span>
      <span class="name">{{ f.name }}</span>
      <span v-if="f.count" class="count">{{ f.count }}</span>
    </div>
    <ul v-if="kids.length && isExpanded">
      <OutlineNode v-for="k in kids" :id="k" :key="k" :depth="depth + 1" :expanded="expanded" @toggle="emit('toggle', $event)" />
    </ul>
  </li>
</template>

<style scoped>
ul { list-style: none; margin: 0; padding: 0; }
.node {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  cursor: pointer;
  white-space: nowrap;
  border-radius: 4px;
  font-size: 12px;
}
.node:hover { background: var(--hov); }
.node.focus { background: var(--hl); font-weight: 600; }
.node.cur, .node.panel { outline: 1px solid var(--accent); outline-offset: -1px; }
.tw {
  width: 14px;
  flex: 0 0 14px;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  font-size: 10px;
}
.icon {
  flex: 0 0 16px;
  height: 16px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  text-align: center;
  line-height: 16px;
  background: var(--kind-bg);
  color: var(--muted);
}
.icon.cte { background: var(--k-function); }
.icon.derived { background: var(--k-rename); }
.icon.subquery { background: var(--k-subquery); }
.icon.branch { background: var(--k-case); }
.icon.columns { background: var(--chip-cols-bg); color: var(--chip-cols-fg); }
.name { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; }
.count { color: var(--muted); font-size: 11px; }
</style>
