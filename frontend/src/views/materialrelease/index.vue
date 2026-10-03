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

    <p class="status-legend">
      <button
        v-for="item in statusSummary"
        :key="item.status"
        class="legend-item legend-btn"
        :class="{ active: statusFilter === item.status }"
        type="button"
        @click="toggleStatusFilter(item.status)"
      >
        {{ item.status }}：{{ item.count }}
      </button>
      <span v-if="statusFilter" class="legend-tip">
        当前仅看「{{ statusFilter }}」清单
        <button class="link" type="button" @click="clearStatusFilter">查看全部</button>
      </span>
    </p>

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
        <tr v-for="row in displayedRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!displayedRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无物料放行数据，可先登记物料放行单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条物料放行记录</span>
      <span v-if="noticeMessage" class="success-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detailRow" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer" data-role="release-detail">
        <header class="drawer-head">
          <h3>物料放行单详情</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="drawer-body">
          <template v-for="item in detailItems" :key="item.label">
            <dt>{{ item.label }}</dt>
            <dd>{{ item.value }}</dd>
          </template>
        </dl>
        <footer class="drawer-foot">详情与列表读取同一份落库记录，检验单号、放行数量以放行单为准。</footer>
      </aside>
    </div>

    <div v-if="createVisible" class="drawer-mask" @click.self="closeCreate">
      <form class="dialog" @submit.prevent="submitCreate">
        <h3>登记物料放行单</h3>
        <label v-for="field in createFields" :key="field.key" class="form-item">
          <span>
            {{ field.label }}
            <em v-if="field.required" class="required-mark">*</em>
          </span>
          <input
            v-model="createForm[field.key]"
            :type="field.type"
            :placeholder="field.placeholder"
          />
        </label>
        <p v-if="createError" class="error-text">{{ createError }}</p>
        <div class="dialog-actions">
          <button class="btn primary" type="submit">保存并登记</button>
          <button class="btn" type="button" @click="closeCreate">取消</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createMaterialRelease,
  downloadEntries,
  getMaterialRelease,
  listMaterialReleases,
  moduleMeta,
  transitionMaterialRelease,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('materialrelease')
const session = useSessionStore()
const columns = ["物料批号", "物料名称", "供应商", "检验单号", "放行数量", "放行人", "放行日期", "放行状态"]
const actions = ["确认放行", "拒绝放行", "冻结物料"]
const statuses = ["待放行", "已放行", "已拒绝", "已冻结"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const statusFilter = ref('')
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '待放行物料', value: countByStatus('待放行') },
  { label: '已放行物料', value: countByStatus('已放行') },
  { label: '已冻结物料', value: countByStatus('已冻结') },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({ status, count: countByStatus(status) })),
)
// 状态页签只在已查出的结果上过滤，待放行清单与全部清单读的是同一份数据
const displayedRows = computed(() =>
  statusFilter.value
    ? rows.value.filter((row) => String(row.status) === statusFilter.value)
    : rows.value,
)

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function toggleStatusFilter(status: string) {
  statusFilter.value = statusFilter.value === status ? '' : status
}

function clearStatusFilter() {
  statusFilter.value = ''
}

function resetFilters() {
  filters.value = {}
  statusFilter.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

// 详情抽屉：直接按编号读落库记录，和列表同源；记录被清理掉就明确提示，不渲染空白抽屉
const detailRow = ref<EntryRow | null>(null)
const detailItems = computed(() => {
  if (!detailRow.value) {
    return []
  }
  const row = detailRow.value
  const items = [{ label: '编号', value: String(row.id) }]
  for (const column of columns) {
    items.push({ label: column, value: String(row[column] || '—') })
  }
  items.push({ label: '当前状态', value: String(row.status) })
  return items
})

function openDetail(row: EntryRow) {
  errorMessage.value = ''
  const fresh = getMaterialRelease(Number(row.id))
  if (!fresh) {
    errorMessage.value = '该物料放行单不存在或已被清理'
    return
  }
  detailRow.value = fresh
}

function closeDetail() {
  detailRow.value = null
}

// 登记对话框：检验单号、放行数量在这里录入，落库后以放行单为准
const createVisible = ref(false)
const createError = ref('')
const createForm = ref<Record<string, string>>({})
const createFields = [
  { key: '物料批号', label: '物料批号', type: 'text', required: true, placeholder: '如 B2026-0904' },
  { key: '物料名称', label: '物料名称', type: 'text', required: true, placeholder: '' },
  { key: '供应商', label: '供应商', type: 'text', required: true, placeholder: '' },
  { key: '检验单号', label: '检验单号', type: 'text', required: true, placeholder: '如 MATE-0004' },
  { key: '放行数量', label: '放行数量', type: 'number', required: true, placeholder: '1~999999 的整数' },
  { key: '放行人', label: '放行人', type: 'text', required: false, placeholder: '可在确认放行时补记' },
  { key: '放行日期', label: '放行日期', type: 'date', required: false, placeholder: '' },
]

function openCreate() {
  createForm.value = {}
  createError.value = ''
  createVisible.value = true
}

function closeCreate() {
  createVisible.value = false
}

function submitCreate() {
  createError.value = ''
  const result = createMaterialRelease({
    物料批号: createForm.value['物料批号'] ?? '',
    物料名称: createForm.value['物料名称'] ?? '',
    供应商: createForm.value['供应商'] ?? '',
    检验单号: createForm.value['检验单号'] ?? '',
    放行数量: Number(createForm.value['放行数量']),
    放行人: createForm.value['放行人'] ?? '',
    放行日期: createForm.value['放行日期'] ?? '',
  })
  if (!result.ok) {
    createError.value = result.message
    return
  }
  createVisible.value = false
  errorMessage.value = ''
  noticeMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = transitionMaterialRelease(Number(row.id), action, session.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
  // 抽屉开着同一张单时同步刷新，两处看到的检验单号、放行数量始终一致
  if (detailRow.value && Number(detailRow.value.id) === Number(row.id)) {
    detailRow.value = getMaterialRelease(Number(row.id))
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listMaterialReleases(filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '物料放行列表读取失败'
  }
}

onMounted(reload)
</script>
