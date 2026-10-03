/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

/** 检验报告单：物料放行单的检验单号、放行数量都以这份台账为准（同源）。 */
export type InspectionReport = {
  检验单号: string
  物料批号: string
  物料名称: string
  检验结论: '合格' | '不合格' | '待检验'
  合格数量: number
  检验日期: string
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  /** 各动作允许从哪些源状态发起：不在表内的动作沿用默认顺序流转；越级一律拦下。 */
  flowRules?: Record<string, string[]>
  /** 视为「待处理 / 待放行」的状态集合；不配置时默认取第一个状态。 */
  pendingStatuses?: string[]
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
