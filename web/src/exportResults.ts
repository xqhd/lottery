import * as XLSX from 'xlsx'
import { apiJson } from './api'

type ResultRow = {
  id?: string
  drawRunId: string
  prizeName: string
  participantName: string
  employeeId: string
  department: string
  timestamp: string
  seed: string
  candidateHash: string
  isDeleted?: boolean
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_')
}

export type ExportResultsOptions = {
  includeDeleted?: boolean
  onlyDeleted?: boolean
  filenameSuffix?: string
}

export async function exportResultsToExcel(eventId: string, eventName: string, options?: ExportResultsOptions): Promise<void> {
  const includeDeleted = Boolean(options?.includeDeleted || options?.onlyDeleted)
  const qs = includeDeleted ? '?includeDeleted=true' : ''

  const data = await apiJson<{ results: ResultRow[] }>(`/api/v1/events/${eventId}/results${qs}`)
  const raw = data.results ?? []
  const results = options?.onlyDeleted ? raw.filter((r) => Boolean(r.isDeleted)) : raw

  if (results.length === 0) {
    throw new Error(options?.onlyDeleted ? '暂无回收站结果可导出' : '暂无抽奖结果可导出')
  }

  const excelRows = results.map((r) => ({
    奖项名称: r.prizeName,
    获奖人: r.participantName,
    工号: r.employeeId,
    部门: r.department,
    中奖时间: new Date(r.timestamp).toLocaleString(),
    随机种子: r.seed,
    候选池哈希: r.candidateHash,
  }))

  const ws = XLSX.utils.json_to_sheet(excelRows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '抽奖结果')

  const date = new Date().toISOString().split('T')[0] ?? ''
  const suffix = options?.filenameSuffix ? `_${options.filenameSuffix}` : ''
  XLSX.writeFile(wb, `${safeFilename(eventName)}_抽奖结果${suffix}_${date}.xlsx`)
}
