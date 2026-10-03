import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pharma-cleanroom:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 放行单按物料批号去重时的状态优先级：同批号只留一条结论最靠后的。
const RELEASE_RANK: Record<string, number> = {
  待放行: 0,
  已拒绝: 1,
  已冻结: 2,
  已放行: 3,
}

function releaseRank(row: EntryRow): number {
  return RELEASE_RANK[String(row.status)] ?? -1
}

// 用另一条同批号记录补齐本记录里为空的字段（落库缺字段的兜底合并）。
function fillBlanks(primary: EntryRow, fallback: EntryRow | undefined): EntryRow {
  if (!fallback) {
    return primary
  }
  const merged: EntryRow = { ...primary }
  for (const [key, value] of Object.entries(fallback)) {
    if (key === 'id' || key === 'status' || key === 'pending' || key === 'abnormal') {
      continue
    }
    if (String(merged[key] ?? '').trim() === '' && String(value ?? '').trim() !== '') {
      merged[key] = value
    }
  }
  return merged
}

// 物料放行单的规范化：
// 1) 同一「物料批号」只保留一条（重复确认产生的残留记录合并后清掉）；
// 2) pending / abnormal 以状态为准，已放行不再挂在待放行清单里。
function normalizeMaterialRelease(rows: EntryRow[]): EntryRow[] {
  const byBatch = new Map<string, EntryRow>()
  for (const row of rows) {
    const batch = String(row['物料批号'] ?? '').trim()
    const dedupeKey = batch || `__id__${row.id}`
    const prev = byBatch.get(dedupeKey)
    if (!prev) {
      byBatch.set(dedupeKey, { ...row })
      continue
    }
    const winner = releaseRank(row) > releaseRank(prev) ? row : prev
    const loser = winner === row ? prev : row
    byBatch.set(dedupeKey, fillBlanks({ ...winner }, loser))
  }
  return [...byBatch.values()]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row, index) => {
      const status = String(row.status)
      return {
        ...row,
        // 去重后重新编号，保证同批号只剩一条，且编号连续。
        id: index + 1,
        // 显示用的「放行状态」与真实状态保持一致，列表不再显示旧值。
        放行状态: status,
        pending: status === '待放行',
        abnormal: status === '已拒绝' || status === '已冻结',
      }
    })
}

function normalizeModule(key: string, rows: EntryRow[]): EntryRow[] {
  const seedById = new Map((SEED_ROWS[key] ?? []).map((row) => [Number(row.id), row]))
  // 先用同 id 的种子记录补齐旧数据里缺失的新增字段。
  let list = rows.map((row) => {
    const seed = seedById.get(Number(row.id))
    return seed ? { ...seed, ...row } : { ...row }
  })
  if (key === 'materialrelease') {
    list = normalizeMaterialRelease(list)
  }
  return list
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  let parsed: Record<string, EntryRow[]>
  try {
    parsed = JSON.parse(raw) as Record<string, EntryRow[]>
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }

  // 读取即规范化：补齐字段、清理重复残留、修正状态标记，并把结果一次性写回。
  const keys = new Set([...Object.keys(fallback), ...Object.keys(parsed)])
  const normalized: Record<string, EntryRow[]> = {}
  for (const key of keys) {
    normalized[key] = normalizeModule(key, parsed[key] ?? clone(fallback[key] ?? []))
  }
  if (JSON.stringify(normalized) !== raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  }
  return normalized
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveAll({ ...allRows(), [key]: rows })
}

// 跨模块动作（确认放行同时回写批生产记录）只写一次库，避免两边各算一份。
// 写入同样过一遍规范化：无论数据从哪条路径进来，同批号残留与错误标记都不会落库。
export function saveAll(next: Record<string, EntryRow[]>): void {
  const normalized: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(next)) {
    normalized[key] = SEED_ROWS[key] ? normalizeModule(key, rows) : rows
  }
  cache = normalized
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
