import { findReport } from '@/data/inspection-reports'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 放行数量的业务边界：必须是正整数，且不超过常规来料批量上限；
// 0、负数、非数字、Infinity、超出上限的极值一律挡回。
const MAX_RELEASE_QTY = 100_000_000

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

// 详情抽屉按 id 取同一份持久化数据，页面不再各算一份、各留一份副本。
export function getEntry(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

// 待处理状态：模块配了 pendingStatuses 用配置，否则默认第一个状态。
function pendingStatuses(meta: ModuleMeta): string[] {
  return meta.pendingStatuses ?? [meta.statuses[0]]
}

function isPending(meta: ModuleMeta, status: string): boolean {
  return pendingStatuses(meta).includes(status)
}

// 校验检验单号 / 放行数量是否满足放行前提（业务口径：放行数量以检验报告单合格数量为准）。
function validateRelease(row: EntryRow): ActionResult {
  const reportNo = String(row['检验单号'] ?? '').trim()
  if (!reportNo) {
    return { ok: false, message: '检验单号为空，无法确认放行' }
  }
  const report = findReport(reportNo)
  if (!report) {
    return { ok: false, message: `检验单号「${reportNo}」在检验台账中查不到，放行已挡回` }
  }
  const batch = String(row['物料批号'] ?? '').trim()
  if (batch && report.物料批号 !== batch) {
    return {
      ok: false,
      message: `检验单号「${reportNo}」对应的物料批号是「${report.物料批号}」，与本单「${batch}」不一致`,
    }
  }
  if (report.检验结论 !== '合格') {
    return {
      ok: false,
      message: `检验单号「${reportNo}」结论为「${report.检验结论}」，不允许放行`,
    }
  }
  const qty = Number(report.合格数量)
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty) || qty > MAX_RELEASE_QTY) {
    return {
      ok: false,
      message: `检验单号「${reportNo}」的合格数量为「${report.合格数量}」，超出允许范围（1~${MAX_RELEASE_QTY.toLocaleString()}），放行已挡回`,
    }
  }
  return { ok: true, message: '' }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// 确认放行 / 拒绝放行 / 冻结物料的专用流转：一次读改写、一次落库，并回写批生产记录。
function runReleaseAction(
  meta: ModuleMeta,
  id: number,
  action: string,
  operator: string,
): ActionResult {
  const rows = listRows(meta.key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)
  const allowed = meta.flowRules?.[action]
  if (allowed && !allowed.includes(current)) {
    if (current === meta.actionTargets[action]) {
      return { ok: false, message: `${meta.entity}已经是「${current}」，该放行单只确认一次，无需重复操作` }
    }
    return { ok: false, message: `当前状态「${current}」不能执行「${action}」，请按状态次序流转` }
  }

  const target = meta.actionTargets[action]
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: false,
    abnormal: action !== '确认放行',
  }

  let batchRows: EntryRow[] = []
  if (action === '确认放行') {
    const invalid = validateRelease(row)
    if (!invalid.ok) {
      return invalid
    }
    const report = findReport(String(row['检验单号']).trim())!
    // 放行数量以检验报告单合格数量为准，页面 / 抽屉不再各算一份。
    updated['放行数量'] = report.合格数量
    updated['放行人'] = String(row['放行人'] ?? '').trim() || operator
    updated['放行日期'] = String(row['放行日期'] ?? '').trim() || today()
    updated['放行状态'] = target

    // 放行结论回写到批生产记录清单：按同一物料批号匹配，只写一次结论。
    batchRows = listRows('batchrecord')
    const conclusion = `已放行｜检验单号 ${report.检验单号}｜放行数量 ${report.合格数量}｜${updated['放行人']}｜${updated['放行日期']}`
    batchRows = batchRows.map((item) =>
      String(item['批号'] ?? '').trim() === String(row['物料批号'] ?? '').trim()
        ? { ...item, 物料放行结论: conclusion }
        : item,
    )
  } else if (action === '拒绝放行') {
    updated['放行状态'] = target
  }

  const nextRows = [...rows]
  nextRows[index] = updated
  // 放行单与批生产记录一起写，只落一次库。
  saveAll({ ...allRows(), [meta.key]: nextRows, ...(batchRows.length ? { batchrecord: batchRows } : {}) })
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function runAction(key: string, id: number, action: string, operator = '值班管理员'): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  // 物料放行走专用流转（同源校验、一次落库、结论回写批生产记录）。
  if (key === 'materialrelease') {
    return runReleaseAction(meta, id, action, operator)
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)

  // 状态按次序流转：配置了 flowRules 的动作只允许从规定的源状态发起，越级拦下。
  const allowedSources = meta.flowRules?.[action]
  if (allowedSources && !allowedSources.includes(current)) {
    if (current === target) {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    return { ok: false, message: `当前状态「${current}」不能执行「${action}」，请按状态次序流转` }
  }
  if (!allowedSources && current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isPending(meta, target),
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

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) =>
        meta.pendingStatuses ? isPending(meta, String(row.status)) : row.pending,
      ).length,
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
