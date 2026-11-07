<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ColumnKind } from "../core/model";
import { folds, layoutDoc, openPanel, result, selectColumn, setFocus, state } from "../state/store";

const KINDS: ColumnKind[] = ["passthrough", "rename", "cast", "literal", "function", "case", "subquery", "other"];

const el = ref<HTMLElement>();
const filter = ref("");
const hidden = ref(new Set<ColumnKind>());
const widthChars = ref(60);

const list = computed(() => (state.panel ? result.value?.columns[state.panel] : undefined));
const ownerName = computed(() => (list.value?.owner ? folds.value[list.value.owner]?.name : "root"));

const counts = computed(() => {
  const c = new Map<ColumnKind, number>();
  for (const it of list.value?.items ?? []) c.set(it.kind, (c.get(it.kind) ?? 0) + 1);
  return c;
});

const rows = computed(() => {
  const l = list.value;
  if (!l) return [];
  const q = filter.value.trim().toLowerCase();
  const exprWidth = Math.max(30, widthChars.value - 6);
  return l.items
    .filter((it) => !hidden.value.has(it.kind))
    .map((it) => {
      const lay = layoutDoc(it.expr, exprWidth);
      const exprText = lay.lines.map((x) => x.tokens.map((t) => t.s).join("")).join(" ");
      return { it, lines: lay.lines, exprText };
    })
    .filter((r) => !q || r.it.outputName.toLowerCase().includes(q) || r.exprText.toLowerCase().includes(q));
});

function toggleKind(k: ColumnKind) {
  const s = new Set(hidden.value);
  if (s.has(k)) s.delete(k);
  else s.add(k);
  hidden.value = s;
}

function onClick(ev: MouseEvent, tagId: string) {
  const chip = (ev.target as HTMLElement).closest<HTMLElement>("[data-fold]");
  if (chip) return setFocus(chip.dataset.fold!);
  selectColumn(tagId);
}

async function copyNames() {
  const names = (list.value?.items ?? []).map((i) => i.outputName).join("\n");
  await navigator.clipboard.writeText(names);
}

watch(
  () => state.selectedTag,
  async (tag) => {
    if (!tag) return;
    await nextTick();
    el.value?.querySelector(`[data-row="${CSS.escape(tag)}"]`)?.scrollIntoView({ block: "nearest" });
  },
);

let ro: ResizeObserver | undefined;
onMounted(() => {
  ro = new ResizeObserver(() => {
    const w = el.value?.clientWidth ?? 480;
    widthChars.value = Math.floor((w - 40) / 7.8);
  });
  ro.observe(el.value!);
});
onBeforeUnmount(() => ro?.disconnect());
</script>

<template>
  <aside ref="el" class="panel">
    <header>
      <div class="title">
        <span class="crumb">{{ ownerName }}</span> › columns
        <span class="muted">({{ list?.items.length ?? 0 }})</span>
        <span class="spacer" />
        <button class="btn" title="Copy output column names" @click="copyNames">Copy names</button>
        <button class="btn" title="Close panel (Esc)" @click="openPanel(null)">✕</button>
      </div>
      <input v-model="filter" class="filter" placeholder="Filter by name or expression…" />
      <div class="kinds">
        <button
          v-for="k in KINDS.filter((k) => counts.get(k))"
          :key="k"
          class="kind"
          :class="[k, { off: hidden.has(k) }]"
          :title="hidden.has(k) ? `Show ${k}` : `Hide ${k}`"
          @click="toggleKind(k)"
        >
          {{ k }} {{ counts.get(k) }}
        </button>
      </div>
    </header>
    <ol class="items">
      <li
        v-for="r in rows"
        :key="r.it.tag"
        :data-row="r.it.tag"
        class="item"
        :class="{ sel: r.it.tag === state.selectedTag }"
        @click="onClick($event, r.it.tag)"
        @mouseenter="state.hoverTag = r.it.tag"
        @mouseleave="state.hoverTag = null"
      >
        <div class="head">
          <span class="idx">{{ r.it.index + 1 }}</span>
          <span class="name">{{ r.it.outputName }}</span>
          <span class="kind small" :class="r.it.kind">{{ r.it.kind }}</span>
        </div>
        <div v-if="r.it.kind !== 'passthrough'" class="expr">
          <div v-for="(l, i) in r.lines" :key="i" class="eline" :style="{ paddingLeft: l.indent + 'ch' }"><template v-for="(t, j) in l.tokens" :key="j"><span
                v-if="t.k === 'fold'"
                class="chip"
                :data-fold="t.fold"
                :title="`Focus ${t.s}`"
              >▸ {{ t.s }}</span><span v-else :class="'t-' + t.k">{{ t.s }}</span></template></div>
        </div>
      </li>
      <li v-if="!rows.length" class="empty">No columns match.</li>
    </ol>
  </aside>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-left: 1px solid var(--border);
  background: var(--panel-bg);
  min-width: 0;
}
header {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.crumb {
  font-family: var(--mono);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.filter {
  width: 100%;
}
.kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.kind {
  font-size: 11px;
  border-radius: 10px;
  padding: 1px 8px;
  border: 1px solid var(--border);
  background: var(--kind-bg);
  color: var(--fg);
  cursor: pointer;
}
.kind.off {
  opacity: 0.4;
  text-decoration: line-through;
}
.kind.small {
  cursor: default;
  margin-left: auto;
  font-size: 10px;
}
.kind.rename { background: var(--k-rename); }
.kind.cast { background: var(--k-cast); }
.kind.literal { background: var(--k-literal); }
.kind.function { background: var(--k-function); }
.kind.case { background: var(--k-case); }
.kind.subquery { background: var(--k-subquery); }
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  flex: 1;
}
.item {
  padding: 5px 12px 5px 8px;
  border-bottom: 1px solid var(--border-soft);
  cursor: pointer;
}
.item:hover {
  background: var(--hov);
}
.item.sel {
  background: var(--hl);
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.idx {
  width: 3ch;
  text-align: right;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  flex: 0 0 auto;
}
.name {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--id);
  overflow-wrap: anywhere;
}
.expr {
  margin-left: calc(3ch + 8px);
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre;
  overflow-x: auto;
  padding: 2px 0;
}
.eline {
  line-height: 18px;
}
.chip {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--chip-bg);
  color: var(--chip-fg);
  border: 1px solid var(--chip-border);
  cursor: pointer;
}
.empty {
  padding: 16px;
  color: var(--muted);
}
.t-kw { color: var(--kw); }
.t-id { color: var(--id); }
.t-fn { color: var(--fn); }
.t-str { color: var(--str); }
.t-num { color: var(--num); }
.t-op { color: var(--op); }
.t-com { color: var(--com); font-style: italic; }
.t-param { color: var(--param); }
.t-plain { color: var(--fg); }
</style>
