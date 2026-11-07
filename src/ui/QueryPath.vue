<script setup lang="ts">
// The path of queries from the top down to the one around the cursor.
import { computed } from "vue";
import { ancestors, caretToSection, localOutline, result, state } from "../state/store";
import { queryLabel, unquote } from "./labels";

const lo = computed(() => localOutline.value);
const secs = computed(() => result.value?.sections ?? []);

/** Queries outside the focused part of the tree: still shown, grayed out. */
function outside(q: number): boolean {
  const f = state.focus;
  if (!f) return false;
  const qf = secs.value[q].fold;
  return !qf || (qf !== f && !ancestors(qf).includes(f));
}
</script>

<template>
  <nav v-if="lo" class="path">
    <template v-for="(q, i) in lo.path" :key="q">
      <span v-if="i > 0" class="sep">›</span>
      <button class="crumb" :class="{ cur: q === lo.query, union: secs[q].kind === 'union', out: outside(q) }" @click="caretToSection(q)">
        {{ unquote(queryLabel(q)) }}
      </button>
    </template>
  </nav>
</template>

<style scoped>
.path {
  display: flex;
  align-items: center;
  gap: 1px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: 12px;
}
.crumb {
  border: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 1px 3px;
  border-radius: 3px;
  flex: 0 1 auto;
  min-width: 2ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
.crumb:hover {
  background: var(--hov);
}
.crumb.cur {
  color: var(--fg);
  font-weight: 600;
  flex-shrink: 0;
}
.crumb.out {
  color: var(--muted);
  opacity: 0.6;
}
.crumb.union {
  font-style: italic;
}
.sep {
  color: var(--muted);
}
</style>
