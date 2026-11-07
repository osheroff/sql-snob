<script setup lang="ts">
import { computed } from "vue";
import { ancestors, folds, setFocus, state } from "../state/store";

const path = computed(() => (state.focus ? [...ancestors(state.focus)].reverse().concat(state.focus) : []).filter((id) => folds.value[id]?.kind !== "columns"));
</script>

<template>
  <div class="crumbs">
    <button class="crumb" :class="{ cur: !state.focus }" @click="setFocus(null)">root</button>
    <template v-for="id in path" :key="id">
      <span class="sep">›</span>
      <button class="crumb" :class="{ cur: id === state.focus }" :title="folds[id].kind" @click="setFocus(id)">{{ folds[id].name }}</button>
    </template>
  </div>
</template>

<style scoped>
.crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  font-family: var(--mono);
  font-size: 12px;
  overflow-x: auto;
  white-space: nowrap;
  min-width: 0;
}
.crumb {
  border: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  font: inherit;
}
.crumb:hover { background: var(--hov); }
.crumb.cur { color: var(--fg); font-weight: 600; cursor: default; }
.sep { color: var(--muted); }
</style>
