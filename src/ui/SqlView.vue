<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  expandDeep,
  folds,
  listForFold,
  mainLayout,
  openPanel,
  setFocus,
  state,
  toggle,
} from "../state/store";

const LINE_H = 20;
const GUTTER_PX = 44;
const BUFFER = 30;

const el = ref<HTMLElement>();
const scrollTop = ref(0);
const viewH = ref(600);
const charW = ref(7.8);
/** What is flashing, by id, so it stays on the right line if the layout re-flows meanwhile. */
const flash = ref<{ id: string; kind: "fold" | "tag" } | null>(null);
const flashLine = computed(() => {
  const f = flash.value;
  const lay = mainLayout.value;
  if (!f || !lay) return -1;
  return (f.kind === "fold" ? lay.foldLine.get(f.id) : lay.tagLine.get(f.id)) ?? -1;
});
let flashTimer: number | undefined;

const lines = computed(() => mainLayout.value?.lines ?? []);

const maxCols = computed(() => {
  let m = 0;
  for (const l of lines.value) {
    let n = l.indent;
    for (const t of l.tokens) n += t.s.length + (t.k === "fold" ? 2 : 0);
    if (n > m) m = n;
  }
  return m;
});

const visible = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / LINE_H) - BUFFER);
  const end = Math.min(lines.value.length, Math.ceil((scrollTop.value + viewH.value) / LINE_H) + BUFFER);
  const out = [];
  for (let n = start; n < end; n++) out.push({ n, l: lines.value[n] });
  return { start, rows: out };
});

const cursorLine = computed(() => (state.cursor ? (mainLayout.value?.foldLine.get(state.cursor) ?? -1) : -1));

function onScroll() {
  scrollTop.value = el.value!.scrollTop;
}

function measure() {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-family:var(--mono);font-size:13px";
  probe.textContent = "M".repeat(100);
  el.value!.appendChild(probe);
  charW.value = probe.getBoundingClientRect().width / 100 || 7.8;
  probe.remove();
}

let ro: ResizeObserver | undefined;
let resizeTimer: number | undefined;
onMounted(() => {
  measure();
  ro = new ResizeObserver(() => {
    const e = el.value!;
    viewH.value = e.clientHeight;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      state.width = Math.max(40, Math.floor((e.clientWidth - GUTTER_PX - 24) / charW.value));
    }, 60);
  });
  ro.observe(el.value!);
});
onBeforeUnmount(() => ro?.disconnect());

// Scroll to a revealed fold/column once the new layout exists.
watch(
  () => [mainLayout.value, state.reveal] as const,
  ([lay, rev]) => {
    if (!lay || !rev) return;
    const line = rev.kind === "fold" ? lay.foldLine.get(rev.id) : lay.tagLine.get(rev.id);
    state.reveal = null;
    if (line === undefined || !el.value) return;
    const top = line * LINE_H;
    const e = el.value;
    if (top < e.scrollTop + LINE_H * 2 || top > e.scrollTop + e.clientHeight - LINE_H * 3) {
      e.scrollTop = Math.max(0, top - e.clientHeight / 3);
    }
    flash.value = rev;
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => (flash.value = null), 900);
  },
  { flush: "post" },
);

// Keep the keyboard cursor on screen.
watch(cursorLine, (line) => {
  const e = el.value;
  if (!e || line < 0) return;
  const top = line * LINE_H;
  if (top < e.scrollTop) e.scrollTop = top - LINE_H * 2;
  else if (top > e.scrollTop + e.clientHeight - LINE_H * 2) e.scrollTop = top - e.clientHeight + LINE_H * 3;
});

function onClick(ev: MouseEvent) {
  const t = ev.target as HTMLElement;
  const g = t.closest<HTMLElement>("[data-toggle]");
  if (g) return toggle(g.dataset.toggle!);
  const fb = t.closest<HTMLElement>("[data-focus]");
  if (fb) return setFocus(fb.dataset.focus!);
  const pb = t.closest<HTMLElement>("[data-panel]");
  if (pb) return openPanel(listForFold(pb.dataset.panel!) ?? null);

  const chip = t.closest<HTMLElement>("[data-fold]");
  if (chip) {
    const id = chip.dataset.fold!;
    state.cursor = id;
    if (ev.metaKey || ev.ctrlKey) return setFocus(id);
    if (folds.value[id]?.kind === "columns" && ev.altKey) return openPanel(listForFold(id) ?? null);
    return ev.altKey ? expandDeep(id) : toggle(id);
  }
  const tg = t.closest<HTMLElement>("[data-tag]");
  if (tg) {
    const tagId = tg.dataset.tag!;
    if (state.panel === tagId.slice(0, tagId.indexOf(":"))) state.selectedTag = tagId;
  }
}

function chipTitle(id: string): string {
  const f = folds.value[id];
  if (!f) return "";
  const what = f.kind === "columns" ? "Click: expand · Alt-click: show in column panel" : "Click: expand · Alt-click: expand all inside\n⌘/Ctrl-click: focus";
  return `${f.name} (${f.kind})\n${what}`;
}
</script>

<template>
  <div ref="el" class="sqlview" @scroll="onScroll" @click="onClick">
    <div class="sizer" :style="{ height: lines.length * LINE_H + 'px', minWidth: `calc(${maxCols + 4}ch + ${GUTTER_PX}px)` }">
      <div class="rows" :style="{ transform: `translateY(${visible.start * LINE_H}px)` }">
        <div
          v-for="{ n, l } in visible.rows"
          :key="n"
          class="row"
          :class="{ flash: n === flashLine, cursor: n === cursorLine }"
        >
          <span class="gutter">
            <template v-if="l.opens">
              <button class="g-btn" :data-toggle="l.opens[0]" :title="`Collapse ${folds[l.opens[0]]?.name}`">▾</button>
              <button
                v-if="folds[l.opens[0]]?.kind === 'columns'"
                class="g-btn g-focus"
                :data-panel="l.opens[0]"
                title="Show in column panel"
              >≡</button>
              <button
                v-else
                class="g-btn g-focus"
                :data-focus="l.opens[0]"
                :title="`Focus ${folds[l.opens[0]]?.name}`"
              >⤢</button>
            </template>
          </span>
          <span class="code" :style="{ paddingLeft: l.indent + 'ch' }"><template v-for="(t, i) in l.tokens" :key="i"><span
                v-if="t.k === 'fold'"
                class="chip"
                :class="[folds[t.fold!]?.kind, { cur: t.fold === state.cursor, hl: t.tag && (t.tag === state.selectedTag || t.tag === state.hoverTag) }]"
                :data-fold="t.fold"
                :title="chipTitle(t.fold!)"
              >▸ {{ t.s }}</span><span
                v-else
                :class="['t-' + t.k, { hl: t.tag && t.tag === state.selectedTag, hov: t.tag && t.tag === state.hoverTag }]"
                :data-tag="t.tag"
              >{{ t.s }}</span></template></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sqlview {
  overflow: auto;
  height: 100%;
  position: relative;
  background: var(--bg);
}
.sizer {
  position: relative;
}
.rows {
  position: absolute;
  inset: 0 0 auto 0;
  will-change: transform;
}
.row {
  height: 20px;
  line-height: 20px;
  display: flex;
  white-space: pre;
}
.row:hover .g-focus {
  opacity: 1;
}
.row.flash {
  animation: flash 0.9s ease-out;
}
.row.cursor {
  background: var(--cursor-bg);
}
@keyframes flash {
  from {
    background: var(--flash);
  }
  to {
    background: transparent;
  }
}
.gutter {
  flex: 0 0 44px;
  display: flex;
  gap: 2px;
  justify-content: flex-end;
  padding-right: 6px;
  user-select: none;
}
.g-btn {
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 2px;
  font-size: 12px;
  line-height: 20px;
}
.g-btn:hover {
  color: var(--accent);
}
.g-focus {
  opacity: 0;
}
.code {
  font-family: var(--mono);
  font-size: 13px;
}
.chip {
  display: inline-block;
  line-height: 16px;
  padding: 0 6px;
  margin: 0 1px;
  border-radius: 4px;
  background: var(--chip-bg);
  color: var(--chip-fg);
  border: 1px solid var(--chip-border);
  cursor: pointer;
  font-size: 12px;
}
.chip:hover {
  border-color: var(--accent);
}
.chip.columns {
  background: var(--chip-cols-bg);
  color: var(--chip-cols-fg);
}
.chip.cur {
  outline: 2px solid var(--accent);
}
.chip.hl {
  border-color: var(--accent);
}
.hl {
  background: var(--hl);
  border-radius: 2px;
}
.hov {
  background: var(--hov);
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
