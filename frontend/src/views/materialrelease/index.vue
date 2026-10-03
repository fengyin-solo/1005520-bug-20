<template>
  <section class="page" data-module="materialrelease">
    <header class="page-head">
      <div>
        <h2>物料放行管理</h2>
        <p class="page-desc">维护物料放行单，围绕物料批号、物料名称、供应商、检验单号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记物料放行单</button>
        <button class="btn" type="button" @click="exportRows">导出物料放行清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="tab-bar" role="tablist">
      <button
        v-for="tab in statusTabs"
        :key="tab.value"
        class="tab-item"
        :class="{ active: activeStatus === tab.value }"
        type="button"
        role="tab"
        @click="switchStatus(tab.value)"
      >
        {{ tab.label }}
      </button>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <button v-if="column === '物料批号'" class="link" type="button" @click="openDetail(row)">
              {{ row[column] ?? '—' }}
            </button>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span class="status-pill" :data-status="row.status">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">该状态下暂无物料放行记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条物料放行记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 详情抽屉：只读取本地数据层那一份，关闭后状态不回退 -->
    <div v-if="drawerVisible" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="物料放行单详情">
        <header class="drawer-head">
          <h3>物料放行单详情</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <div v-if="detailRow" class="drawer-body">
          <dl class="detail-list">
            <div v-for="column in columns" :key="column" class="detail-row">
              <dt>{{ column }}</dt>
              <dd>{{ detailRow[column] || '—' }}</dd>
            </div>
            <div class="detail-row">
              <dt>当前状态</dt>
              <dd><span class="status-pill" :data-status="detailRow.status">{{ detailRow.status }}</span></dd>
            </div>
          </dl>

          <section class="report-card">
            <h4>检验报告单（放行数量以此为准）</h4>
            <dl v-if="boundReport" class="detail-list">
              <div class="detail-row"><dt>检验单号</dt><dd>{{ boundReport.检验单号 }}</dd></div>
              <div class="detail-row"><dt>检验结论</dt><dd>{{ boundReport.检验结论 }}</dd></div>
              <div class="detail-row"><dt>合格数量</dt><dd>{{ boundReport.合格数量 }}</dd></div>
              <div class="detail-row"><dt>检验日期</dt><dd>{{ boundReport.检验日期 }}</dd></div>
            </dl>
            <p v-else class="error-text">检验单号「{{ detailRow['检验单号'] }}」在检验台账中查不到。</p>
          </section>

          <div class="drawer-actions">
            <button
              v-for="action in availableActions(detailRow)"
              :key="action"
              class="btn"
              :class="{ primary: action === '确认放行' }"
              type="button"
              @click="runAction(action, detailRow)"
            >
              {{ action }}
            </button>
          </div>
        </div>
        <div v-else class="drawer-body empty-state">记录不存在或已被清理。</div>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { findReport } from '@/data/inspection-reports'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const session = useSessionStore()
const meta = moduleMeta('materialrelease')
const columns = ['物料批号', '物料名称', '供应商', '检验单号', '放行数量', '放行人', '放行日期', '放行状态']
const statuses = ['待放行', '已放行', '已拒绝', '已冻结']
const statusTabs = [
  { label: '待放行', value: '待放行' },
  { label: '已放行', value: '已放行' },
  { label: '已冻结', value: '已冻结' },
  { label: '已拒绝', value: '已拒绝' },
  { label: '全部', value: '' },
]

// 状态次序：只暴露当前状态真正能执行的动作，越级动作根本点不到。
const NEXT_ACTIONS: Record<string, string[]> = {
  待放行: ['确认放行', '拒绝放行'],
  已放行: ['冻结物料'],
  已拒绝: [],
  已冻结: [],
}

const rows = ref<EntryRow[]>([])
const allList = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const activeStatus = ref('待放行')

const drawerVisible = ref(false)
const detailId = ref<number | null>(null)
// 详情按 id 实时取本地数据层那一条：确认落库后抽屉与列表看到的永远一致。
const detailRow = computed<EntryRow | undefined>(() =>
  detailId.value === null ? undefined : getEntry(meta.key, detailId.value),
)
const boundReport = computed(() =>
  detailRow.value ? findReport(String(detailRow.value['检验单号'] ?? '')) : undefined,
)

const stats = computed(() => [
  { label: '待放行物料', value: countStatus('待放行') },
  { label: '已放行物料', value: countStatus('已放行') },
  { label: '已冻结物料', value: countStatus('已冻结') },
])

function countStatus(status: string): number {
  return allList.value.filter((row) => String(row.status) === status).length
}

function availableActions(row: EntryRow): string[] {
  return NEXT_ACTIONS[String(row.status)] ?? []
}

function switchStatus(status: string) {
  activeStatus.value = status
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '物料放行单登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
  drawerVisible.value = true
}

function closeDetail() {
  drawerVisible.value = false
  detailId.value = null
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, session.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  // 重新从数据层读取：一次落库后列表、抽屉、统计全部同源刷新，状态不会退回待放行。
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    allList.value = listEntries(meta.key).items
    const scoped = activeStatus.value
      ? allList.value.filter((row) => String(row.status) === activeStatus.value)
      : allList.value
    const filtered = (() => {
      const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
      if (!pairs.length) {
        return scoped
      }
      return scoped.filter((row) =>
        pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
      )
    })()
    rows.value = filtered
    total.value = filtered.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '物料放行列表读取失败'
  }
}

onMounted(reload)
</script>
