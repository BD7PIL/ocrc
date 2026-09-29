<!-- src/lib/components/Inspector.svelte -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { sessionList, feeds } from '$lib/stores/sessions.js'
  import { can } from '$lib/stores/capabilities.js'
  import TaskPanel from './inspector/TaskPanel.svelte'
  import McpPanel from './inspector/McpPanel.svelte'
  import SchedulesPanel from './inspector/SchedulesPanel.svelte'
  import SkillsPanel from './inspector/SkillsPanel.svelte'
  import FilesPanel from './inspector/FilesPanel.svelte'
  import WorktreesPanel from './inspector/WorktreesPanel.svelte'
  import UsagePanel from './inspector/UsagePanel.svelte'
  import ContextPanel from './inspector/ContextPanel.svelte'
  import WorkingDirPanel from './inspector/WorkingDirPanel.svelte'
  import Fold from './inspector/Fold.svelte'
  export let sessionId: string | undefined = undefined

  $: session = $sessionList.find((s) => s.id === sessionId)
  $: title = session?.title

  // Debounced "activity tick": bump ~1s after the feed's lastSeq changes so
  // panels refetch when a turn produces output, without hammering per delta.
  let tick = 0
  let lastSeen = -1
  let timer: ReturnType<typeof setTimeout> | undefined
  $: seq = sessionId ? ($feeds[sessionId]?.lastSeq ?? 0) : 0
  $: if (seq !== lastSeen) { lastSeen = seq; clearTimeout(timer); timer = setTimeout(() => (tick += 1), 1000) }
  onDestroy(() => clearTimeout(timer))
</script>

<aside class="inspector">
  <div class="head">
    <div class="section-label">会话</div>
    <div class="name" title={title ?? sessionId}>
      <span class="title-text">{title || (sessionId ? '…' + sessionId.slice(-8) : 'No session')}</span>
    </div>
  </div>
  {#if $can('todos')}
    <Fold key="tasks" title="任务" defaultOpen={true}><TaskPanel {sessionId} {tick} /></Fold>
  {/if}
  <div class="pinned">
    <Fold key="schedules" title="定时任务" defaultOpen={true}><SchedulesPanel {tick} /></Fold>
    <div class="divider"></div>
    {#if $can('skills')}<Fold key="skills" title="Skills" defaultOpen={false}><SkillsPanel {tick} /></Fold><div class="divider"></div>{/if}
    {#if $can('files')}<Fold key="files" title="Files" defaultOpen={false}><FilesPanel {sessionId} {tick} /></Fold><div class="divider"></div>{/if}
    {#if $can('worktrees')}<Fold key="worktrees" title="Worktrees" defaultOpen={false}><WorktreesPanel {sessionId} {tick} /></Fold><div class="divider"></div>{/if}
    {#if $can('mcp')}
      <Fold key="mcp" title="MCP" defaultOpen={true}><McpPanel {tick} /></Fold>
      <div class="divider"></div>
    {/if}
    <Fold key="usage" title="用量" defaultOpen={true}><UsagePanel {sessionId} {tick} /></Fold>
    <div class="divider"></div>
    <Fold key="context" title="上下文" defaultOpen={true}><ContextPanel {sessionId} {tick} /></Fold>
    <div class="divider"></div>
    <Fold key="workdir" title="工作目录" defaultOpen={true}><WorkingDirPanel {sessionId} {tick} showDiff={$can('diff')} /></Fold>
  </div>
</aside>

<style>
  .inspector {
    width: var(--insp-w, 280px);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border-left: 1px solid var(--border-2);
  }
  .head {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border-2);
  }
  .section-label {
    text-transform: uppercase;
    letter-spacing: .16em;
    color: var(--text-3);
    font-size: 10px;
  }
  .name {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-weight: 600;
    font-size: 13px;
    color: var(--text);
  }
  .title-text {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pinned {
    border-top: 1px solid var(--border-2);
    padding: 14px 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .divider {
    border-top: 1px solid var(--border-2);
  }

  /* Mobile bottom sheet: the whole inspector scrolls as one column (vs the desktop
     Tasks-scroll / pinned-bottom split) so nothing is clipped or unreachable. */
  @media (max-width: 820px) {
    .inspector {
      width: 100%;
      height: 100%;
      display: block;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    .pinned { border-top: none; }
  }
</style>
