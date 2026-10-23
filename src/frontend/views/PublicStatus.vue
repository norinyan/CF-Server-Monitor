<template>
  <main class="norin-status">
    <div class="status-shell">
      <header class="status-header">
        <a class="wordmark" href="/" aria-label="NORIN 状态首页">NORIN<span>/ STATUS</span></a>
        <button class="theme-switch" type="button" @click="toggleTheme" aria-label="切换深浅色主题">
          {{ { auto: '跟随系统', dark: '深色', light: '浅色' }[currentTheme] }} ◐
        </button>
      </header>

      <section class="status-intro" aria-live="polite">
        <p class="eyebrow">INFRASTRUCTURE · 基础设施</p>
        <h1>保持连接。<br><span>一切状态，清晰可见。</span></h1>
        <p class="status-summary"><i :class="{ warning: error || snapshot?.stats.offline > 0, pending: !snapshot }" />{{ summary }}</p>
      </section>

      <section v-if="snapshot" class="status-counts" aria-label="服务器汇总">
        <div><span>全部节点</span><strong>{{ snapshot.stats.total }}</strong></div>
        <div><span>在线</span><strong>{{ snapshot.stats.online }}</strong></div>
        <div><span>离线</span><strong>{{ snapshot.stats.offline }}</strong></div>
      </section>

      <section class="node-section" aria-label="节点状态" :aria-busy="loading">
        <div class="section-heading"><h2>节点概览</h2><span>每 60 秒自动刷新</span></div>
        <div v-if="error" class="empty-state" role="alert">
          <p>暂时无法获取状态，请稍后重试。</p>
          <button type="button" @click="refresh" :disabled="loading">重新获取</button>
        </div>
        <p v-else-if="!snapshot" class="empty-state">正在获取节点状态…</p>
        <p v-else-if="!snapshot.servers.length" class="empty-state">暂无公开节点。</p>
        <ul v-else class="node-list">
          <li v-for="(server, index) in snapshot.servers" :key="index">
            <div class="node-name">{{ server.name }}</div>
            <span class="node-region">{{ server.region || '地区未设置' }}</span>
            <span class="node-state" :class="{ offline: !server.online }"><i />{{ server.online ? '在线' : '离线' }}</span>
          </li>
        </ul>
      </section>
      <footer class="status-footer"><span>NORIN · SYSTEM STATUS</span><a href="/admin#/admin">管理后台 ↗</a></footer>
    </div>
  </main>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useTheme } from '../composables/useTheme'
import { getApiBases } from '../utils/config'

const { currentTheme, toggleTheme } = useTheme()
const snapshot = ref(null)
const error = ref(false)
const loading = ref(false)
let timer
let controller
const summary = computed(() => {
  if (error.value) return '状态暂不可用'
  if (!snapshot.value) return '正在检查状态'
  if (!snapshot.value.stats.total) return '等待节点接入'
  return snapshot.value.stats.offline ? '部分节点离线' : '所有节点运行正常'
})

async function refresh() {
  if (loading.value) return
  loading.value = true
  controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(`${getApiBases()[0] || ''}/api/status`, {
      credentials: 'omit', cache: 'no-store', signal: controller.signal
    })
    if (!response.ok) throw new Error('Status unavailable')
    const data = await response.json()
    if (!Array.isArray(data.servers) || !data.stats) throw new Error('Invalid status')
    snapshot.value = data
    error.value = false
  } catch {
    error.value = true
    snapshot.value = null
  } finally {
    clearTimeout(timeout)
    loading.value = false
  }
}
onMounted(() => { document.title = 'NORIN / STATUS'; refresh(); timer = setInterval(refresh, 60000) })
onBeforeUnmount(() => { clearInterval(timer); controller?.abort() })
</script>

<style scoped>
.norin-status { --surface: #111715; --line: #29352f; --ink: #eaf1eb; --muted: #93a399; --accent: #91dfa6; --off: #edb881; min-height: 100svh; background: #0b100e; color: var(--ink); font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 0 28px; }
:global(body.light .norin-status) { --surface: #fff; --line: #dce4de; --ink: #1c3024; --muted: #617568; --accent: #247b46; --off: #9c591c; background: #f5f7f3; }
.status-shell { width: min(100%, 920px); margin: 0 auto; }
.status-header { display: flex; align-items: center; justify-content: space-between; padding: 34px 0; border-bottom: 1px solid var(--line); gap: 16px; }
.norin-status a { color: inherit; text-decoration: none; }
.wordmark { font-size: 23px; font-weight: 800; letter-spacing: .12em; }
.wordmark span { color: var(--muted); font-size: 11px; font-weight: 500; letter-spacing: .08em; margin-left: 14px; }
.norin-status button { border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--ink); padding: 10px 14px; cursor: pointer; font: inherit; font-size: 12px; }
.norin-status a:focus-visible, .norin-status button:focus-visible { outline: 2px solid var(--accent); outline-offset: 5px; }
.status-intro { padding: 72px 0 42px; }
.eyebrow { font-size: 10px; letter-spacing: .18em; color: var(--muted); margin: 0 0 22px; }
.status-intro h1 { margin: 0; font-size: clamp(30px, 5vw, 48px); line-height: 1.5; letter-spacing: -.04em; font-weight: 550; }
.status-intro h1 span { color: var(--muted); }
.status-summary { display: flex; align-items: center; gap: 10px; margin-top: 26px; font-size: 14px; }
.status-summary i, .node-state i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.status-summary i.warning { background: var(--off); }
.status-summary i.pending { background: var(--muted); }
.status-counts { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line); border-radius: 12px; background: var(--surface); padding: 25px 0; }
.status-counts div { padding: 0 28px; border-right: 1px solid var(--line); }
.status-counts div:last-child { border-right: 0; }
.status-counts span { color: var(--muted); font-size: 12px; display: block; }
.status-counts strong { display: block; margin-top: 6px; font-size: 32px; font-weight: 500; font-variant-numeric: tabular-nums; }
.node-section { margin-top: 48px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 15px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
.section-heading h2 { font-size: 14px; font-weight: 500; margin: 0; }
.section-heading span { color: var(--muted); font-size: 11px; }
.node-list { list-style: none; padding: 0; margin: 0; }
.node-list li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(90px, .35fr) 65px; gap: 20px; align-items: center; padding: 23px 0; border-bottom: 1px solid var(--line); }
.node-name { font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
.node-region { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.node-state { display: flex; align-items: center; justify-content: flex-end; gap: 8px; font-size: 12px; color: var(--accent); white-space: nowrap; }
.node-state.offline { color: var(--off); }
.node-state.offline i { background: var(--off); }
.empty-state { text-align: center; color: var(--muted); padding: 50px 15px; font-size: 13px; }
.status-footer { display: flex; justify-content: space-between; gap: 16px; margin-top: 72px; padding: 24px 0 36px; color: var(--muted); font-size: 10px; letter-spacing: .08em; }
.status-footer a:hover { color: var(--ink); }
@media (max-width: 540px) { .norin-status { padding: 0 20px; } .status-header { padding: 24px 0; } .wordmark { font-size: 19px; } .wordmark span { margin-left: 8px; font-size: 9px; } .status-intro { padding-top: 48px; } .status-counts div { padding: 0 18px; } .status-counts strong { font-size: 27px; } .node-list li { grid-template-columns: minmax(0, 1fr) 65px; gap: 8px 16px; } .node-region { grid-column: 1; grid-row: 2; } .node-state { grid-column: 2; grid-row: 1 / 3; } }
</style>
