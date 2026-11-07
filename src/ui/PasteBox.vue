<script setup lang="ts">
import { nextTick, ref } from "vue";
import example from "../examples/measurements.sql?raw";
import { load, state } from "../state/store";

const text = ref(state.sql);
const dragging = ref(false);

function submit() {
  if (text.value.trim()) load(text.value);
}
async function onPaste() {
  await nextTick();
  submit();
}
async function onDrop(ev: DragEvent) {
  dragging.value = false;
  const file = ev.dataTransfer?.files[0];
  if (!file) return;
  text.value = await file.text();
  submit();
}
function loadExample() {
  text.value = example;
  submit();
}
</script>

<template>
  <div class="paste" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
    <h1>sql-snob</h1>
    <p class="sub">Paste a query. It's formatted, folded and navigable. Nothing leaves your browser.</p>
    <textarea
      v-model="text"
      autofocus
      spellcheck="false"
      placeholder="Paste SQL here (or drop a .sql file)…"
      @paste="onPaste"
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
</template>

<style scoped>
.paste {
  max-width: 1100px;
  margin: 0 auto;
  padding: 48px 16px 24px;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; }
.sub { margin: 0; color: var(--muted); }
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
