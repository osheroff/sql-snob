<script setup lang="ts">
import LocalOutline from "./LocalOutline.vue";
import Outline from "./Outline.vue";
</script>

<template>
  <aside class="sidebar">
    <LocalOutline class="pane context-pane" />
    <Outline class="pane outline-pane" />
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--panel-bg);
}
.pane {
  min-height: 0;
  overflow: auto;
}
.outline-pane {
  flex: 0 0 auto;
  max-height: 45%;
  border-top: 1px solid var(--border);
}
.context-pane {
  flex: 1 1 auto;
}
</style>
