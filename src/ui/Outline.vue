<script setup lang="ts">
import { ref, watch } from "vue";
import { ancestors, folds, result, state } from "../state/store";
import OutlineNode from "./OutlineNode.vue";

/** Outline nodes expanded in the tree (independent of fold state in the code view). */
const expanded = ref(new Set<string>());

// Start with the first three levels expanded.
watch(
  result,
  (r) => {
    const s = new Set<string>();
    if (r) for (const f of Object.values(r.folds)) if (ancestors(f.id).length < 3) s.add(f.id);
    expanded.value = s;
  },
  { immediate: true },
);

// Keep the focused / cursor fold visible in the tree.
watch(
  () => [state.focus, state.cursor],
  () => {
    const ids = [state.focus, state.cursor].filter((x): x is string => !!x && !!folds.value[x]);
    if (!ids.length) return;
    const s = new Set(expanded.value);
    for (const id of ids) ancestors(id).forEach((a) => s.add(a));
    expanded.value = s;
  },
);

/** The tree itself starts closed; remembered per browser. */
const TREE_KEY = "sql-snob:outline-tree";
function readTree(): boolean {
  try {
    return localStorage.getItem(TREE_KEY) === "open";
  } catch {
    return false;
  }
}
const open = ref(readTree());
function toggleTree() {
  open.value = !open.value;
  try {
    localStorage.setItem(TREE_KEY, open.value ? "open" : "closed");
  } catch {
    /* storage unavailable */
  }
}

function toggle(id: string) {
  const s = new Set(expanded.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  expanded.value = s;
}
</script>

<template>
  <nav class="outline" :class="{ open }">
    <button class="head" :title="open ? 'Hide the outline of the whole query' : 'Show the outline of the whole query'" @click="toggleTree">
      <span class="tri">{{ open ? "▾" : "▸" }}</span>
      <span>Outline</span>
      <span class="n">{{ Object.keys(folds).length }}</span>
    </button>
    <template v-if="open">
      <ul v-if="result?.roots.length">
        <OutlineNode v-for="id in result.roots" :id="id" :key="id" :depth="0" :expanded="expanded" @toggle="toggle" />
      </ul>
      <p v-else class="empty">No subqueries, CTEs or long SELECT lists.</p>
    </template>
  </nav>
</template>

<style scoped>
.outline {
  overflow: auto;
  background: var(--panel-bg);
  padding: 4px 4px;
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 0;
  background: none;
  cursor: pointer;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  padding: 3px 6px;
  border-radius: 3px;
  text-align: left;
}
.head:hover {
  background: var(--hov);
  color: var(--fg);
}
.tri {
  font-size: 10px;
  width: 1em;
}
.n {
  margin-left: auto;
}
ul { list-style: none; margin: 0; padding: 0; }
.empty { color: var(--muted); font-size: 12px; padding: 6px; }
</style>
