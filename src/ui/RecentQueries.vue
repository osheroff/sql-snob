<script setup lang="ts">
import { ref } from "vue";
import { forgetQuery, openQuery, savedQueries, type SavedQuery } from "../state/store";

const emit = defineEmits<{ (e: "empty"): void }>();
const list = ref<SavedQuery[]>(savedQueries());

/** One-line preview: the SQL without comments, whitespace collapsed. */
function preview(sql: string): string {
  const s = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}

function lines(sql: string): string {
  const n = sql.trimEnd().split("\n").length;
  return n === 1 ? "1 line" : `${n.toLocaleString()} lines`;
}

function ago(at: number): string {
  if (!at) return "";
  const s = (Date.now() - at) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(at).toLocaleDateString();
}

function forget(id: string) {
  forgetQuery(id);
  list.value = list.value.filter((q) => q.id !== id);
  if (!list.value.length) emit("empty");
}
</script>

<template>
  <aside v-if="list.length" class="recent">
    <h2>Recent queries</h2>
    <ul>
      <li v-for="q in list" :key="q.id">
        <a :href="`/q/${q.id}`" class="item" @click.prevent="openQuery(q.id)">
          <span class="sql">{{ preview(q.sql) }}</span>
          <span class="meta muted">{{ lines(q.sql) }}<template v-if="q.at"> · {{ ago(q.at) }}</template></span>
        </a>
        <button class="forget" title="Forget this query" @click="forget(q.id)">×</button>
      </li>
    </ul>
    <p class="muted small">Saved in this browser only.</p>
  </aside>
</template>

<style scoped>
.recent {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
li { position: relative; }
.item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 28px 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-bg);
  color: var(--fg);
  text-decoration: none;
}
.item:hover { border-color: var(--accent); }
.sql {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.meta { font-size: 11px; }
.forget {
  position: absolute;
  top: 4px;
  right: 4px;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
  padding: 2px 6px;
  cursor: pointer;
  border-radius: 4px;
}
.forget:hover { color: var(--fg); background: var(--border); }
.small { font-size: 11px; margin: 0; }
</style>
