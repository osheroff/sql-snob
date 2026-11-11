<script setup lang="ts">
import { computed, ref, watch, watchEffect } from "vue";
import {
  canCollapseAll,
  canExpandAll,
  caretPos,
  collapseAll,
  copyText,
  expandAll,
  folds,
  localOutline,
  mainLayout,
  reprint,
  reset,
  openRoute,
  result,
  setFocus,
  state,
  toggleOutline,
} from "./state/store";
import { shareQuery } from "./state/share";
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleQuestionMark,
  Copy,
  Crosshair,
  PanelLeftOpen,
  Plus,
  Share,
  SlidersHorizontal,
} from "lucide-vue-next";
import DialectPicker from "./ui/DialectPicker.vue";
import Sidebar from "./ui/Sidebar.vue";
import ParseErrorView from "./ui/ParseErrorView.vue";
import PasteBox from "./ui/PasteBox.vue";
import QueryPath from "./ui/QueryPath.vue";
import SqlView from "./ui/SqlView.vue";

const showOpts = ref(false);
const showHelp = ref(false);
// Options closes when the mouse leaves it (and its button), after a grace period.
let optsTimer = 0;
function closeOptsSoon() {
  clearTimeout(optsTimer);
  optsTimer = window.setTimeout(() => (showOpts.value = false), 400);
}
function keepOpts() {
  clearTimeout(optsTimer);
}

// The popup flags live here, not in the viewer, so close them when leaving it (New query…).
watch(
  () => state.status,
  (s) => {
    if (s !== "ready") showOpts.value = showHelp.value = false;
  },
);

const position = computed(() => {
  const n = mainLayout.value?.lines.length ?? 0;
  const p = caretPos.value;
  return p ? `Line ${p.line + 1} of ${n}, column ${p.col + 1}` : `${n} lines`;
});

/** The fold of the query around the cursor (null for the top-level query). */
const curFold = computed(() => {
  const l = localOutline.value;
  return l ? (result.value?.sections[l.query]?.fold ?? null) : null;
});
function toggleFocus() {
  if (state.focus) setFocus(null);
  else if (curFold.value) setFocus(curFold.value);
}

const copied = ref(false);
async function copy() {
  const text = copyText();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1200);
}

/** Upload an encrypted copy and put its link on the clipboard. */
const shareMsg = ref<string | null>(null);
async function share() {
  shareMsg.value = "Sharing…";
  try {
    const link = await shareQuery(state.sql);
    await navigator.clipboard.writeText(link);
    shareMsg.value = "Link copied";
  } catch (e) {
    shareMsg.value = e instanceof Error && e.message.startsWith("That") ? e.message : "Sharing failed";
  }
  setTimeout(() => (shareMsg.value = null), 2500);
}

function editSql() {
  reset();
}

function onOpt() {
  reprint();
}

// Tab title: what's on screen, so tabs and history entries are told apart.
watchEffect(() => {
  let what = "";
  if (state.status === "error") what = "Parse error";
  else if (state.status === "ready") {
    if (state.focus) what = folds.value[state.focus]?.name ?? "";
    else {
      // The main query's first table (top level: not inside a CTE or subquery fold).
      const src = result.value?.sections.find((s) => s.kind === "source" && s.fold === null);
      what = src?.target ?? src?.label ?? "";
    }
    what ||= "Query";
  }
  document.title = what ? `SQL Snob – ${what}` : "SQL Snob";
});

// Show what the URL says (paste box or `/q/<id>`) before child components read `state.sql`.
openRoute();
</script>

<template>
  <PasteBox v-if="state.status === 'empty' || (state.status === 'loading' && !result && !state.restoring)" />
  <!-- Reloading a viewed query: render nothing until it's parsed, rather than flash the paste box. -->
  <div v-else-if="state.status === 'loading' && !result" />
  <ParseErrorView v-else-if="state.status === 'error'" @edit="editSql" />
  <div v-else class="app" :class="{ 'outline-closed': !state.outlineOpen }">
    <Sidebar v-if="state.outlineOpen" class="outline" />
    <div class="main">
      <div class="tools">
        <button v-if="!state.outlineOpen" class="btn icon sidebar-toggle" title="Show sidebar" @click="toggleOutline"><PanelLeftOpen :size="14" /></button>
        <QueryPath class="qpath" />
        <button class="btn" title="Back to the paste box with an empty query" @click="reset(true)"><Plus :size="14" />New query</button>
        <button class="btn" title="Copy all the SQL in the view, fully expanded" @click="copy">
          <Check v-if="copied" :size="14" /><Copy v-else :size="14" />{{ copied ? "Copied" : "Copy" }}
        </button>
        <button
          class="btn"
          :class="{ on: state.focus }"
          :disabled="!state.focus && !curFold"
          :title="state.focus ? 'Show the whole SQL again' : curFold ? `Focus on ${folds[curFold]?.name}` : 'Show only the query around the cursor'"
          @click="toggleFocus"
        ><Crosshair :size="14" />{{ state.focus ? "Unfocus" : "Focus" }}</button>
        <button class="btn" title="Expand everything in view" :disabled="!canExpandAll" @click="expandAll"><ChevronsUpDown :size="14" />Expand</button>
        <button class="btn" title="Collapse everything in view" :disabled="!canCollapseAll" @click="collapseAll"><ChevronsDownUp :size="14" />Collapse</button>
        <button
          class="btn"
          title="An encrypted copy will be sent to the server"
          :disabled="shareMsg === 'Sharing…'"
          @click="share"
        ><Share :size="14" />{{ shareMsg ?? "Share" }}</button>
      </div>
      <SqlView class="code" />
    </div>
    <footer class="status">
      <span class="pos">{{ position }}</span>
      <span class="right">
        <DialectPicker />
        <div class="opts-wrap" @mouseleave="closeOptsSoon" @mouseenter="keepOpts">
          <button class="foot-btn" @click="showOpts = !showOpts"><SlidersHorizontal :size="15" />Options</button>
          <!-- The zone's transparent padding is a margin of error around the panel for the mouse. -->
          <div v-if="showOpts" class="opts-zone"><div class="opts">
            <label><input v-model="state.opts.removeParens" type="checkbox" @change="onOpt" /> Remove redundant parentheses</label>
            <label><input v-model="state.opts.hideObviousCasts" type="checkbox" @change="onOpt" /> Hide obvious casts (<code>'x'::TEXT</code>)</label>
            <label><input v-model="state.opts.collapseAliases" type="checkbox" @change="onOpt" /> Collapse <code>"X" AS "X"</code></label>
            <label><input v-model="state.opts.stripQuotes" type="checkbox" @change="onOpt" /> Remove unneeded quotes (<code>"rows"."id"</code>)</label>
          </div></div>
        </div>
        <button class="foot-btn" title="Help" @click="showHelp = !showHelp"><CircleQuestionMark :size="16" /></button>
      </span>
    </footer>
    <div v-if="showHelp" class="help" @click="showHelp = false">
      <div class="help-card" @click.stop>
        <h3>Mouse</h3>
        <dl>
          <dt>Click chip</dt><dd>Expand</dd>
          <dt>Alt-click chip</dt><dd>Expand everything inside</dd>
          <dt>⌘/Ctrl-click chip</dt><dd>Focus</dd>
          <dt>Gutter ▾ / ▸</dt><dd>Collapse / expand</dd>
          <dt>← → ↑ ↓</dt><dd>Move the cursor</dd>
          <dt>Outline</dt><dd>Click to show, double-click to focus</dd>
          <dt>Focus / Unfocus</dt><dd>Show only the query in the sidebar / everything</dd>
          <dt>Local outline</dt><dd>Click a row to move the cursor there · › to go into a subquery</dd>
        </dl>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    "outline main"
    "status status";
  height: 100%;
}
.app.outline-closed {
  grid-template-columns: 0 minmax(0, 1fr);
}
.main {
  grid-area: main;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.code {
  flex: 1 1 auto;
  min-height: 0;
}
.tools {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-bg);
}
.qpath {
  flex: 1 1 auto;
  margin-right: 8px;
}
.tools .btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  padding: 5px 12px;
}
.tools .btn.on {
  border-color: var(--accent);
  color: var(--accent);
}
.tools .btn.icon {
  padding: 5px 9px;
}
.opts-wrap { position: relative; }
.opts-zone {
  position: absolute;
  right: -16px;
  bottom: 100%;
  z-index: 10;
  padding: 16px 16px 8px;
  font-size: 13px;
}
.opts {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  white-space: nowrap;
  box-shadow: 0 8px 24px var(--shadow);
}
.outline { grid-area: outline; }
.status {
  grid-area: status;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 6px 16px;
  align-items: center;
  font-size: 11px;
  border-top: 1px solid var(--border);
  background: var(--panel-bg);
  white-space: nowrap;
}
.pos { overflow: hidden; text-overflow: ellipsis; }
.right { display: flex; align-items: center; gap: 6px; }
.foot-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: inherit;
  font-size: 13px;
  color: var(--fg);
  background: none;
  border: 0;
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
}
.foot-btn:hover { color: var(--accent); background: var(--hov); }
.help {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: grid;
  place-items: center;
  z-index: 20;
}
.help-card {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 20px;
  max-width: 520px;
}
.help-card h3 { margin: 4px 0 8px; font-size: 13px; }
dl { display: grid; grid-template-columns: 9em 1fr; gap: 4px 12px; margin: 0 0 12px; font-size: 13px; }
dt { font-family: var(--mono); color: var(--accent); }
dd { margin: 0; }
@media (max-width: 800px) {
  /* No sidebar on narrow screens, open or closed (`.outline-closed` must be overridden too). */
  .app,
  .app.outline-closed {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
    grid-template-areas: "main" "status";
  }
  .outline,
  .sidebar-toggle { display: none; }
}
</style>
