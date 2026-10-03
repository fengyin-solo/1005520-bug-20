import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// ===== 物料放行：专用领域逻辑 =====
// 业务裁定（放行数量与检验单号谁说了算）：两个字段在登记放行单时录入并校验，
// 落库后以放行单上的字段为唯一来源；列表、详情抽屉、导出、回写批生产记录都读同一份，
// 任何视图不自行另算，确认放行只翻转状态、不改这两个字段。
const MATERIAL_KEY = 'materialrelease'
const BATCH_RECORD_KEY = 'batchrecord'
const MATERIAL_ENTITY = '物料放行单'
const MATERIAL_INITIAL_STATUS = '待放行'
// 状态只许按「待放行 → 已放行/已拒绝/已冻结」这一次序流转，终态不可再动
const MATERIAL_STATUS_ORDER = ['待放行', '已放行', '已拒绝', '已冻结']
const MATERIAL_TRANSITIONS: Record<string, string> = {
  确认放行: '已放行',
  拒绝放行: '已拒绝',
  冻结物料: '已冻结',
}
// 检验单号格式：2~8 位字母前缀 + 短横线 + 4~8 位数字（如 MATE-0001）；
// 为空、过短、超长、纯符号等极值一律挡回
const INSPECTION_NO_PATTERN = /^[A-Za-z]{2,8}-\d{4,8}$/
const RELEASE_QUANTITY_MIN = 1
const RELEASE_QUANTITY_MAX = 999999

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function materialStatusRank(row: EntryRow): number {
  const index = MATERIAL_STATUS_ORDER.indexOf(String(row.status))
  return index < 0 ? 0 : index
}

function normalizeMaterialRows(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  // 同一物料批号只留一条：状态走得最远的那条算数，并列时留编号最小的，多出的残留记录清掉
  const byBatchNo = new Map<string, EntryRow>()
  for (const row of rows) {
    const batchNo = String(row['物料批号'] ?? '')
    const kept = byBatchNo.get(batchNo)
    if (!kept) {
      byBatchNo.set(batchNo, row)
      continue
    }
    changed = true
    const winner =
      materialStatusRank(row) > materialStatusRank(kept) ||
      (materialStatusRank(row) === materialStatusRank(kept) && Number(row.id) < Number(kept.id))
        ? row
        : kept
    byBatchNo.set(batchNo, winner)
  }
  const normalized = [...byBatchNo.values()]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) => {
      // pending / abnormal / 放行状态字段都由当前状态派生，顺手修掉历史遗留的旧值
      const status = String(row.status)
      const next: EntryRow = {
        ...row,
        pending: status === MATERIAL_INITIAL_STATUS,
        abnormal: status === '已拒绝' || status === '已冻结',
        放行状态: status,
      }
      if (
        next.pending !== row.pending ||
        next.abnormal !== row.abnormal ||
        row['放行状态'] !== status
      ) {
        changed = true
      }
      return next
    })
  return { rows: normalized, changed }
}

function loadMaterialRows(): EntryRow[] {
  const { rows, changed } = normalizeMaterialRows(listRows(MATERIAL_KEY))
  if (changed) {
    // 清理结果一次落库，之后列表、抽屉、看板读到的都是这份
    saveRows(MATERIAL_KEY, rows)
  }
  return rows
}

export function listMaterialReleases(filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(loadMaterialRows(), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getMaterialRelease(id: number): EntryRow | null {
  const row = loadMaterialRows().find((item) => Number(item.id) === id)
  return row ? { ...row } : null
}

export function validateInspectionNo(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return '检验单号不能为空'
  }
  if (!INSPECTION_NO_PATTERN.test(trimmed)) {
    return '检验单号须为「字母前缀-数字编号」（如 MATE-0001），前缀 2~8 位字母、编号 4~8 位数字，极值一律挡回'
  }
  return null
}

export function validateReleaseQuantity(value: number): string | null {
  if (!Number.isInteger(value) || value < RELEASE_QUANTITY_MIN || value > RELEASE_QUANTITY_MAX) {
    return `放行数量须为 ${RELEASE_QUANTITY_MIN}~${RELEASE_QUANTITY_MAX} 的整数`
  }
  return null
}

export type MaterialReleaseInput = {
  物料批号: string
  物料名称: string
  供应商: string
  检验单号: string
  放行数量: number
  放行人?: string
  放行日期?: string
}

export function createMaterialRelease(input: MaterialReleaseInput): ActionResult {
  const batchNo = input.物料批号.trim()
  const name = input.物料名称.trim()
  const supplier = input.供应商.trim()
  if (!batchNo || !name || !supplier) {
    return { ok: false, message: '物料批号、物料名称、供应商都不能为空' }
  }
  const inspectionNo = input.检验单号.trim()
  const inspectionError = validateInspectionNo(inspectionNo)
  if (inspectionError) {
    return { ok: false, message: inspectionError }
  }
  const quantityError = validateReleaseQuantity(input.放行数量)
  if (quantityError) {
    return { ok: false, message: quantityError }
  }
  const rows = loadMaterialRows()
  if (rows.some((row) => String(row['物料批号']) === batchNo)) {
    return { ok: false, message: `物料批号 ${batchNo} 已存在放行单，同一物料批号只保留一张` }
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id,
    status: MATERIAL_INITIAL_STATUS,
    pending: true,
    abnormal: false,
    物料批号: batchNo,
    物料名称: name,
    供应商: supplier,
    检验单号: inspectionNo,
    放行数量: input.放行数量,
    放行人: input.放行人?.trim() ?? '',
    放行日期: input.放行日期?.trim() ?? '',
    放行状态: MATERIAL_INITIAL_STATUS,
  }
  saveRows(MATERIAL_KEY, [...rows, row])
  return { ok: true, message: `${MATERIAL_ENTITY}已登记，编号 ${id}，当前状态「${MATERIAL_INITIAL_STATUS}」` }
}

export function transitionMaterialRelease(
  id: number,
  action: string,
  operator = '值班管理员',
): ActionResult {
  const target = MATERIAL_TRANSITIONS[action]
  if (!target) {
    return { ok: false, message: `${MATERIAL_ENTITY}没有登记「${action}」这个动作` }
  }
  const rows = loadMaterialRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${MATERIAL_ENTITY}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    // 同一张放行单重复确认只算一次：幂等返回，不重复落库、不产生残留记录
    return { ok: true, message: `${MATERIAL_ENTITY}已是「${target}」，重复${action}不再落库` }
  }
  if (current !== MATERIAL_INITIAL_STATUS) {
    // 越级拦下：只有「待放行」能流转，终态（已放行/已拒绝/已冻结）不可再动
    return {
      ok: false,
      message: `${MATERIAL_ENTITY}当前状态「${current}」，不允许再执行「${action}」，状态须按「待放行 → 已放行/已拒绝/已冻结」次序流转`,
    }
  }
  // 落库前复核同源字段：检验单号、放行数量以放行单为准，极值挡回
  const inspectionError = validateInspectionNo(String(rows[index]['检验单号'] ?? ''))
  if (inspectionError) {
    return { ok: false, message: `放行前校验未通过：${inspectionError}` }
  }
  const quantityError = validateReleaseQuantity(Number(rows[index]['放行数量']))
  if (quantityError) {
    return { ok: false, message: `放行前校验未通过：${quantityError}` }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: false,
    abnormal: target !== '已放行',
    放行状态: target,
    放行人:
      target === '已放行'
        ? String(rows[index]['放行人'] ?? '').trim() || operator
        : rows[index]['放行人'],
    放行日期:
      target === '已放行'
        ? String(rows[index]['放行日期'] ?? '').trim() || today()
        : rows[index]['放行日期'],
  }
  const next = [...rows]
  next[index] = updated
  // 确认放行一次落库：只写这一张单，不新增、不复制
  saveRows(MATERIAL_KEY, next)
  const synced = writeBackBatchRecord(updated)
  const suffix = synced
    ? '，结论已回写批生产记录清单'
    : '，未找到同批号的批生产记录，结论未回写'
  return { ok: true, message: `${MATERIAL_ENTITY}已${action}，当前状态「${target}」${suffix}` }
}

// 结论回写到批生产记录的清单：按「批号 = 物料批号」找到对应批生产记录，写入放行结论
function writeBackBatchRecord(release: EntryRow): boolean {
  const batchNo = String(release['物料批号'] ?? '').trim()
  if (!batchNo) {
    return false
  }
  const rows = listRows(BATCH_RECORD_KEY)
  let touched = false
  const next = rows.map((row) => {
    if (String(row['批号'] ?? '').trim() !== batchNo) {
      return row
    }
    touched = true
    return { ...row, 放行结论: String(release.status) }
  })
  if (touched) {
    saveRows(BATCH_RECORD_KEY, next)
  }
  return touched
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    // 物料放行走清理后的同一份数据，看板计数才和放行清单对得上
    const entries = meta.key === MATERIAL_KEY ? loadMaterialRows() : (rows[meta.key] ?? [])
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
