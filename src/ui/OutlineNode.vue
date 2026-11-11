<script setup lang="ts">
import { computed } from "vue";
import { caretToFold, folds, outlineKids, setFocus, state } from "../state/store";

const props = defineProps<{ id: string; depth: number }>();

const f = computed(() => folds.value[props.id]);
const kids = computed(() => outlineKids(f.value?.children ?? []));
const ICON: Record<string, string> = { cte: "W", derived: "F", subquery: "S", branch: "U" };

function onClick() {
  // Moving the cursor there keeps "This query" in sync with what you clicked.
  caretToFold(props.id);
}
function onDbl() {
  setFocus(props.id);
}
</script>

<template>
  <li v-if="f">
    <div
      class="node"
      :class="{ focus: state.focus === id, cur: state.cursor === id }"
      :style="{ paddingLeft: depth * 12 + 6 + 'px' }"
      :title="`${f.name} (${f.kind})\nClick: go there · Double-click: focus`"
      @click="onClick"
      @dblclick="onDbl"
    >
      <span class="icon" :class="f.kind">{{ ICON[f.kind] }}</span>
      <span class="name">{{ f.name }}</span>
      <span v-if="f.count" class="count">{{ f.count }}</span>
    </div>
    <ul v-if="kids.length">
      <OutlineNode v-for="k in kids" :id="k" :key="k" :depth="depth + 1" />
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
.node.cur { outline: 1px solid var(--accent); outline-offset: -1px; }
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
.name { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; }
.count { color: var(--muted); font-size: 11px; }
</style>
