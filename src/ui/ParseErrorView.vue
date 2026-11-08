<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { state } from "../state/store";
import { dialectNames } from "../core/model";
import DialectPicker from "./DialectPicker.vue";

const emit = defineEmits<{ (e: "edit"): void }>();
const el = ref<HTMLElement>();
const lines = computed(() => state.sql.split("\n"));
const errLine = computed(() => state.error?.line ?? 1);
const CONTEXT = 200;
const shown = computed(() => {
  const start = Math.max(0, errLine.value - 1 - CONTEXT);
  return lines.value.slice(start, errLine.value + CONTEXT).map((s, i) => ({ n: start + i + 1, s }));
});

onMounted(async () => {
  await nextTick();
  el.value?.querySelector(".err")?.scrollIntoView({ block: "center" });
});
</script>

<template>
  <div class="errview">
    <div class="banner">
      <div>
        <strong>Couldn't parse this query<template v-if="state.error?.dialect"> as {{ dialectNames[state.error.dialect] }}</template></strong>
        <span class="muted"> — line {{ state.error?.line }}, column {{ state.error?.col }}</span>
        <pre class="msg">{{ state.error?.message }}</pre>
        <p class="muted small">
          The viewer parses Postgres and MySQL; Snowflake is parsed as Postgres, so some Snowflake-only syntax isn't
          supported yet. Showing the raw text below.
        </p>
      </div>
      <div class="actions">
        <DialectPicker />
        <button class="btn" @click="emit('edit')">Edit SQL</button>
      </div>
    </div>
    <div ref="el" class="raw">
      <div v-for="l in shown" :key="l.n" class="line" :class="{ err: l.n === errLine }">
        <span class="ln">{{ l.n }}</span><span class="src">{{ l.s }}</span>
        <div v-if="l.n === errLine" class="caret" :style="{ paddingLeft: `calc(${(state.error?.col ?? 1) - 1}ch + 6ch)` }">^</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.errview { display: flex; flex-direction: column; height: 100%; }
.banner {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--err-bg);
}
.msg { white-space: pre-wrap; font-family: var(--mono); font-size: 12px; margin: 6px 0; max-height: 6em; overflow: auto; }
.small { font-size: 12px; margin: 0; }
.actions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; font-size: 12px; }
.raw { flex: 1; overflow: auto; font-family: var(--mono); font-size: 13px; padding: 8px 0; }
.line { white-space: pre; line-height: 20px; }
.line.err { background: var(--err-bg); }
.ln { display: inline-block; width: 5ch; text-align: right; margin-right: 1ch; color: var(--muted); user-select: none; }
.caret { color: var(--err); font-weight: 700; line-height: 14px; }
</style>
