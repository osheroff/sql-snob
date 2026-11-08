<script setup lang="ts">
import { ref } from "vue";
import example from "../examples/measurements.sql?raw";
import { savedQueries, state, submitQuery } from "../state/store";
import RecentQueries from "./RecentQueries.vue";

const text = ref(state.sql);
const dragging = ref(false);
const hasRecent = ref(savedQueries().length > 0);

function submit() {
  if (text.value.trim()) submitQuery(text.value);
}
async function onDrop(ev: DragEvent) {
  dragging.value = false;
  const file = ev.dataTransfer?.files[0];
  if (!file) return;
  text.value = await file.text();
}
function loadExample() {
  text.value = example;
  submit();
}
</script>

<template>
  <div class="home" :class="{ 'has-recent': hasRecent }">
  <div class="paste" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
    <h1>sql-snob</h1>
    <p class="sub">Paste a query. It's formatted, folded and navigable. Nothing leaves your browser.</p>
    <p v-if="state.notice" class="notice">{{ state.notice }}</p>
    <textarea
      v-model="text"
      autofocus
      spellcheck="false"
      placeholder="Paste SQL here (or drop a .sql file)…"
      @keydown.meta.enter="submit"
      @keydown.ctrl.enter="submit"
    />
    <div class="actions">
      <button class="btn primary" :disabled="!text.trim() || state.status === 'loading'" @click="submit">
        {{ state.status === "loading" ? "Parsing…" : "View" }}
      </button>
      <span class="muted">⌘/Ctrl + Enter</span>
      <span class="spacer" />
      <button class="btn link" @click="loadExample">Try an example</button>
    </div>
  </div>
  <RecentQueries v-if="hasRecent" class="side" @empty="hasRecent = false" />
  </div>
</template>

<style scoped>
.home {
  max-width: 1100px;
  margin: 0 auto;
  height: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
.home.has-recent {
  max-width: 1420px;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 8px;
}
.paste {
  padding: 48px 16px 24px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
/* Recent queries: aligned with the textarea, below the heading. */
.side {
  padding: 120px 16px 24px 0;
  min-height: 0;
}
@media (max-width: 800px) {
  .home.has-recent {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(400px, 1fr) auto;
    height: auto;
    min-height: 100%;
  }
  .side { padding: 0 16px 24px; }
}
h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; }
.sub { margin: 0; color: var(--muted); }
.notice {
  margin: 0;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  background: var(--panel-bg);
}
textarea {
  flex: 1;
  min-height: 300px;
  width: 100%;
  resize: none;
  font-family: var(--mono);
  font-size: 13px;
  padding: 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel-bg);
  color: var(--fg);
  outline: none;
}
textarea:focus { border-color: var(--accent); }
.dragging textarea { border-style: dashed; border-color: var(--accent); }
.actions { display: flex; align-items: center; gap: 12px; }
.spacer { flex: 1; }
</style>
