<script setup lang="ts">
import { computed, ref } from "vue";
import { outlineKids, result } from "../state/store";
import OutlineNode from "./OutlineNode.vue";

const roots = computed(() => outlineKids(result.value?.roots ?? []));

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
</script>

<template>
  <nav class="outline" :class="{ open }">
    <button class="head" :title="open ? 'Hide the outline of the whole query' : 'Show the outline of the whole query'" @click="toggleTree">
      <span class="tri">{{ open ? "▾" : "▸" }}</span>
      <span>Outline</span>
    </button>
    <template v-if="open">
      <ul v-if="roots.length">
        <OutlineNode v-for="id in roots" :id="id" :key="id" :depth="0" />
      </ul>
      <p v-else class="empty">No subqueries or CTEs.</p>
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
ul { list-style: none; margin: 0; padding: 0; }
.empty { color: var(--muted); font-size: 12px; padding: 6px; }
</style>
