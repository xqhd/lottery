import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { apiJson } from '../api'
import { friendlyErrorMessage } from '../friendlyError'

export type ParticipantInput = {
  seq: number
  name: string
  employeeId: string
  department: string
  weight?: number
}

const SEQ_HEADERS = new Set(['seq', '序号', '序', 'index', '序列', 'no', 'number'])
const NAME_HEADERS = new Set(['name', '姓名', '名字'])
const EMPLOYEE_ID_HEADERS = new Set(['employee_id', 'employeeid', '工号', '员工号', '编号', 'id'])
const DEPT_HEADERS = new Set(['department', 'dept', '部门'])
const WEIGHT_HEADERS = new Set(['weight', '权重'])

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function cellMatches(set: Set<string>, cell: unknown): boolean {
  if (typeof cell !== 'string') return false
  return set.has(normalizeKey(cell))
}

type HeaderMap = {
  seqIdx: number
  nameIdx: number
  employeeIdIdx: number
  departmentIdx: number
  weightIdx: number
}

function inferHeaderMap(rows: unknown[][]): { headerRowCount: number; map: HeaderMap } {
  const defaultMap: HeaderMap = { seqIdx: -1, nameIdx: 0, employeeIdIdx: 1, departmentIdx: 2, weightIdx: -1 }
  const header = rows[0]
  if (!header) return { headerRowCount: 0, map: defaultMap }

  const looksLikeHeader = header.some(
    (cell) =>
      cellMatches(SEQ_HEADERS, cell) ||
      cellMatches(NAME_HEADERS, cell) ||
      cellMatches(EMPLOYEE_ID_HEADERS, cell) ||
      cellMatches(DEPT_HEADERS, cell) ||
      cellMatches(WEIGHT_HEADERS, cell),
  )

  if (!looksLikeHeader) return { headerRowCount: 0, map: defaultMap }

  const map: HeaderMap = { ...defaultMap }
  let foundEmployeeId = false
  let foundDepartment = false
  for (let i = 0; i < header.length; i++) {
    const cell = header[i]
    if (cellMatches(SEQ_HEADERS, cell)) map.seqIdx = i
    else if (cellMatches(NAME_HEADERS, cell)) map.nameIdx = i
    else if (cellMatches(EMPLOYEE_ID_HEADERS, cell)) {
      map.employeeIdIdx = i
      foundEmployeeId = true
    } else if (cellMatches(DEPT_HEADERS, cell)) {
      map.departmentIdx = i
      foundDepartment = true
    } else if (cellMatches(WEIGHT_HEADERS, cell)) map.weightIdx = i
  }

  // Header exists but no employee id column -> avoid accidentally reusing name column
  // (common when the sheet begins with 序号 + 姓名).
  if (!foundEmployeeId) map.employeeIdIdx = -1
  if (!foundDepartment) map.departmentIdx = -1

  return { headerRowCount: 1, map }
}

function coerceString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value).trim()
  return String(value).trim()
}

function coerceWeight(value: unknown): number | undefined {
  const str = coerceString(value)
  if (!str) return undefined
  const num = Number(str)
  return Number.isFinite(num) ? num : undefined
}

function coerceSeq(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    const n = Math.floor(value)
    return n > 0 ? n : undefined
  }
  const str = coerceString(value)
  if (!str) return undefined
  const num = Number(str)
  if (!Number.isFinite(num)) return undefined
  const n = Math.floor(num)
  return n > 0 ? n : undefined
}

function parseRows(rows: unknown[][]): ParticipantInput[] {
  if (rows.length === 0) return []

  const { headerRowCount, map } = inferHeaderMap(rows)
  const out: ParticipantInput[] = []

  for (let i = headerRowCount; i < rows.length; i++) {
    const row = rows[i] ?? []

    const name = coerceString(row[map.nameIdx])
    if (!name) continue

    const seq = map.seqIdx >= 0 ? coerceSeq(row[map.seqIdx]) : undefined
    const employeeId = map.employeeIdIdx >= 0 ? coerceString(row[map.employeeIdIdx]) : ''
    const department = map.departmentIdx >= 0 ? coerceString(row[map.departmentIdx]) : ''
    const weight = map.weightIdx >= 0 ? coerceWeight(row[map.weightIdx]) : undefined

    out.push({ seq: seq ?? i - headerRowCount + 1, name, employeeId, department, weight })
  }

  return out
}

async function parseParticipantsFromFile(file: File): Promise<ParticipantInput[]> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''

  if (ext === 'txt') {
    const text = await file.text()
    const lines = text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
    return lines.map((name, idx) => ({ seq: idx + 1, name, employeeId: '', department: '' }))
  }

  if (ext === 'csv') {
    const text = await file.text()
    const wb = XLSX.read(text, { type: 'string' })
    const sheetName = wb.SheetNames[0]
    if (!sheetName) return []
    const ws = wb.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false }) as unknown[][]
    return parseRows(rows)
  }

  if (ext === 'xlsx' || ext === 'xls') {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const sheetName = wb.SheetNames[0]
    if (!sheetName) return []
    const ws = wb.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false }) as unknown[][]
    return parseRows(rows)
  }

  return []
}

export function ImportParticipants(props: { eventId: string; onUploadSuccess?: () => void }) {
  const { eventId, onUploadSuccess } = props

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [participants, setParticipants] = useState<ParticipantInput[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [selectedFileName, setSelectedFileName] = useState<string>('')
  const [lastImport, setLastImport] = useState<string>('')
  const [totalCount, setTotalCount] = useState<number | null>(null)

  const preview = useMemo(() => participants.slice(0, 5), [participants])

  useEffect(() => {
    if (!eventId) return
    let cancelled = false
    const load = async () => {
      try {
        const data = await apiJson<{ total: number }>(`/api/v1/events/${eventId}/participants/stats`)
        if (cancelled) return
        setTotalCount(Number.isFinite(data.total) ? data.total : 0)
      } catch {
        if (cancelled) return
        setTotalCount(null)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [eventId])

  async function onFile(file: File) {
    setError('')
    setLastImport('')
    const parsed = await parseParticipantsFromFile(file)
    if (parsed.length === 0) {
      setParticipants([])
      setError('文件里没解析出任何人（请检查表头/内容）')
      return
    }
    setParticipants(parsed)
  }

  async function onUpload() {
    if (!eventId || participants.length === 0) return

    setError('')
    setLoading(true)
    try {
      const data = await apiJson<{ result: { inserted: number; updated: number; skipped: number } }>(
        `/api/v1/events/${eventId}/participants/batch`,
        {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ participants }),
        },
      )

      const stats = await apiJson<{ total: number }>(`/api/v1/events/${eventId}/participants/stats`).catch(() => ({ total: NaN }))
      const total = Number.isFinite(stats.total) ? stats.total : null
      setTotalCount(total)

      const { inserted, updated, skipped } = data.result ?? { inserted: 0, updated: 0, skipped: 0 }
      const totalText = total !== null ? `；当前总人数：${total} 人` : ''
      setLastImport(`✅ 导入成功：新增 ${inserted}，更新 ${updated}，跳过 ${skipped}${totalText}`)

      setParticipants([])
      setSelectedFileName('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      onUploadSuccess?.()
    } catch (err) {
      setError(friendlyErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3 text-left">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-base font-bold text-white">导入名单（Excel 优先）</div>
          <div className="text-xs text-slate-400 mt-1">当前名单：{totalCount === null ? '—' : `${totalCount} 人`}</div>
        </div>
      </div>

      <input
        type="file"
        accept=".xlsx,.xls,.csv,.txt"
        ref={fileInputRef}
        className="block w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-slate-700 file:text-white hover:file:bg-slate-600"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (!f) return
          setSelectedFileName(f.name)
          onFile(f).catch((err) => setError(friendlyErrorMessage(err)))
        }}
      />

      {selectedFileName ? (
        <div className="text-xs text-slate-400">
          已选择：<span className="font-mono text-slate-200">{selectedFileName}</span>
        </div>
      ) : null}

      <div className="text-xs text-slate-500">
        支持：xlsx/xls/csv/txt；列名识别：name/姓名，employee_id/工号，department/部门，weight/权重（可选）
      </div>

      {lastImport ? <div className="text-sm text-green-300">{lastImport}</div> : null}
      {error ? <div className="text-sm text-red-300">{error}</div> : null}

      {participants.length ? (
        <div className="space-y-3">
          <div className="text-xs text-slate-400">预览前 5 条（共 {participants.length} 人）：</div>
          <pre className="max-h-44 overflow-auto bg-black/40 text-slate-200 p-3 rounded border border-slate-700 text-xs">
            {JSON.stringify(preview, null, 2)}
          </pre>
          <button
            onClick={() => void onUpload()}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 rounded text-white font-semibold hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? '上传中…' : '确认导入'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
