<script setup lang="ts">
import { ref, watch } from "vue";
import { ancestors, folds, result, state, toggleOutline } from "../state/store";
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

function toggle(id: string) {
  const s = new Set(expanded.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  expanded.value = s;
}
</script>

<template>
  <nav class="outline">
    <div class="head">
      <span>Outline</span>
      <button class="collapse" title="Collapse outline (s)" @click="toggleOutline">«</button>
    </div>
    <ul v-if="result?.roots.length">
      <OutlineNode v-for="id in result.roots" :id="id" :key="id" :depth="0" :expanded="expanded" @toggle="toggle" />
    </ul>
    <p v-else class="empty">No subqueries, CTEs or long SELECT lists.</p>
  </nav>
</template>

<style scoped>
.outline {
  height: 100%;
  overflow: auto;
  border-right: 1px solid var(--border);
  background: var(--panel-bg);
  padding: 6px 4px;
}
.collapse {
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}
.collapse:hover { color: var(--accent); }
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  padding: 2px 6px 6px;
}
ul { list-style: none; margin: 0; padding: 0; }
.empty { color: var(--muted); font-size: 12px; padding: 6px; }
</style>
