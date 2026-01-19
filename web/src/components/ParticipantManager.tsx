import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson } from '../api'
import { friendlyErrorMessage } from '../friendlyError'
import { ImportParticipants } from './ImportParticipants'

type ParticipantRow = {
  id: string
  seq: number
  employeeId: string
  name: string
  department: string
  weight: number
}

type ParticipantsResponse = {
  participants: ParticipantRow[]
  total: number
  page: number
  limit: number
  q: string
}

type EditDraft = {
  name: string
  employeeId: string
  department: string
  weight: string
}

function clampPage(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.floor(value)
}

function parseWeight(value: string, fallback: number): number {
  const raw = value.trim()
  if (!raw) return fallback
  const num = Number(raw)
  return Number.isFinite(num) && num > 0 ? num : fallback
}

export function ParticipantManager(props: { eventId: string }) {
  const { eventId } = props

  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const limit = 20

  const [participants, setParticipants] = useState<ParticipantRow[]>([])
  const [total, setTotal] = useState(0)
  const [overallTotal, setOverallTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [showImport, setShowImport] = useState(false)

  const [editingId, setEditingId] = useState('')
  const [editDraft, setEditDraft] = useState<EditDraft>({ name: '', employeeId: '', department: '', weight: '' })
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string>('')

  const totalPages = useMemo(() => {
    const pages = Math.ceil((total || 0) / limit)
    return pages > 0 ? pages : 1
  }, [limit, total])

  const loadOverallTotal = useCallback(async () => {
    if (!eventId) return
    try {
      const data = await apiJson<{ total: number }>(`/api/v1/events/${eventId}/participants/stats`)
      setOverallTotal(Number.isFinite(data.total) ? data.total : 0)
    } catch {
      setOverallTotal(0)
    }
  }, [eventId])

  const loadPage = useCallback(
    async (opts?: { page?: number; q?: string }) => {
      if (!eventId) return

      const nextPage = clampPage(opts?.page ?? page)
      const q = (opts?.q ?? query).trim()

      setError('')
      setLoading(true)
      try {
        const qs = new URLSearchParams({
          page: String(nextPage),
          limit: String(limit),
          q,
        })
        const data = await apiJson<ParticipantsResponse>(`/api/v1/events/${eventId}/participants?${qs.toString()}`)
        setParticipants(data.participants ?? [])
        setTotal(Number.isFinite(data.total) ? data.total : 0)
        if (!q) setOverallTotal(Number.isFinite(data.total) ? data.total : 0)
        setPage(nextPage)
        setQuery(q)
      } catch (e) {
        setError(friendlyErrorMessage(e))
      } finally {
        setLoading(false)
      }
    },
    [eventId, limit, page, query],
  )

  useEffect(() => {
    setSearchInput('')
    setQuery('')
    setPage(1)
    setParticipants([])
    setTotal(0)
    setOverallTotal(0)
    setEditingId('')
    setShowImport(false)
    void loadOverallTotal()
  }, [eventId, loadOverallTotal])

  useEffect(() => {
    if (!eventId) return
    void loadPage({ page, q: query })
  }, [eventId, loadPage, page, query])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = searchInput.trim()
      if (next === query) return
      setPage(1)
      setQuery(next)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query, searchInput])

  function openEdit(row: ParticipantRow) {
    setError('')
    setEditingId(row.id)
    setEditDraft({
      name: row.name ?? '',
      employeeId: row.employeeId ?? '',
      department: row.department ?? '',
      weight: String(row.weight ?? 1),
    })
  }

  function cancelEdit() {
    if (saving) return
    setEditingId('')
  }

  async function saveEdit(id: string) {
    const row = participants.find((p) => p.id === id)
    if (!row) return
    if (saving) return

    setError('')
    setSaving(true)
    try {
      const nextWeight = parseWeight(editDraft.weight, row.weight ?? 1)
      const payload = {
        name: editDraft.name.trim(),
        employeeId: editDraft.employeeId.trim(),
        department: editDraft.department.trim(),
        weight: nextWeight,
      }

      const data = await apiJson<{ participant: ParticipantRow }>(`/api/v1/participants/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const updated = data.participant
      setParticipants((prev) => prev.map((p) => (p.id === id ? updated : p)))
      setEditingId('')
    } catch (e) {
      setError(friendlyErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  async function deleteOne(id: string) {
    if (deletingId) return
    const row = participants.find((p) => p.id === id)
    if (!row) return

    const ok = window.confirm(`确定删除 “${row.name}” 吗？\n\n注意：已中奖的人无法删除（为了审计完整性）。`)
    if (!ok) return

    setError('')
    setDeletingId(id)
    try {
      await apiJson(`/api/v1/participants/${id}`, { method: 'DELETE' })
      const nextTotal = Math.max(0, total - 1)
      const nextTotalPages = Math.ceil(nextTotal / limit) || 1
      const nextPage = Math.min(page, nextTotalPages)
      await loadPage({ page: nextPage })
      await loadOverallTotal()
    } catch (e) {
      setError(friendlyErrorMessage(e))
    } finally {
      setDeletingId('')
    }
  }

  async function clearAll() {
    const ok = window.confirm(`⚠️ 高危操作：确定清空本活动的所有候选人吗？\n\n将删除本活动全部 ${overallTotal} 人。此操作不可恢复。`)
    if (!ok) return

    setError('')
    setLoading(true)
    try {
      await apiJson(`/api/v1/events/${eventId}/participants`, { method: 'DELETE' })
      setParticipants([])
      setTotal(0)
      setOverallTotal(0)
      setPage(1)
      setQuery('')
      setSearchInput('')
    } catch (e) {
      const err = e as { code?: string } | undefined
      if (err?.code === 'EVENT_HAS_DRAWS') {
        const okReset = window.confirm(
          '本活动已有抽奖结果。\n\n为了保证审计一致性，系统会先“清空中奖结果”（回收站/重置），再清空名单。\n\n是否继续？',
        )
        if (!okReset) {
          setError(friendlyErrorMessage(e))
          return
        }

        try {
          await apiJson(`/api/v1/events/${eventId}/reset`, { method: 'POST' })
          await apiJson(`/api/v1/events/${eventId}/participants`, { method: 'DELETE' })
          setParticipants([])
          setTotal(0)
          setOverallTotal(0)
          setPage(1)
          setQuery('')
          setSearchInput('')
          return
        } catch (e2) {
          setError(friendlyErrorMessage(e2))
          return
        }
      }

      setError(friendlyErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center gap-3">
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="搜索：姓名 / 工号 / 部门"
              className="w-full md:w-80 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-slate-100 placeholder:text-slate-500 outline-none focus:border-blue-500"
            />
            <div className="text-xs text-slate-400">
              {loading ? (
                '加载中…'
              ) : (
                <>
                  共 {overallTotal} 人
                  {query ? (
                    <span className="ml-2">
                      （筛选命中 {total} 人：{query}）
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="px-4 py-2 bg-blue-600 rounded text-white font-semibold hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => setShowImport(true)}
              disabled={!eventId}
            >
              导入名单
            </button>
            <button
              className="px-4 py-2 bg-red-900/40 border border-red-800 rounded text-red-200 hover:bg-red-900/60 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => void clearAll()}
              disabled={!eventId || overallTotal === 0}
            >
              清空名单
            </button>
          </div>
        </div>

        {error ? <div className="mt-3 text-sm text-red-300">{error}</div> : null}
      </div>

      <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl overflow-hidden">
        <div className="overflow-auto">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-900 text-slate-400 uppercase font-bold">
              <tr>
                <th className="px-6 py-3 w-[96px]">序号</th>
                <th className="px-6 py-3 w-[160px]">工号</th>
                <th className="px-6 py-3">姓名</th>
                <th className="px-6 py-3">部门</th>
                <th className="px-6 py-3 w-[120px]">权重</th>
                <th className="px-6 py-3 w-[160px]">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-10 text-center text-slate-500">
                    加载中…
                  </td>
                </tr>
              ) : participants.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                    暂无数据，请先导入 Excel。
                    <div className="mt-4">
                      <button
                        className="px-4 py-2 bg-blue-600 rounded text-white font-semibold hover:bg-blue-500"
                        onClick={() => setShowImport(true)}
                      >
                        导入名单
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                participants.map((p, idx) => {
                  const isEditing = editingId === p.id
                  const fallbackSeq = (page - 1) * limit + idx + 1
                  const displaySeq = Number.isFinite(p.seq) && p.seq > 0 ? p.seq : fallbackSeq
                  return (
                    <tr key={p.id} className="hover:bg-slate-700/30">
                      <td className="px-6 py-3 font-mono text-slate-400">{displaySeq}</td>
                      <td className="px-6 py-3 font-mono text-slate-400">
                        {isEditing ? (
                          <input
                            value={editDraft.employeeId}
                            onChange={(e) => setEditDraft((prev) => ({ ...prev, employeeId: e.target.value }))}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-100 outline-none focus:border-blue-500"
                          />
                        ) : p.employeeId ? (
                          p.employeeId
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-6 py-3 font-bold text-white">
                        {isEditing ? (
                          <input
                            value={editDraft.name}
                            onChange={(e) => setEditDraft((prev) => ({ ...prev, name: e.target.value }))}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-100 outline-none focus:border-blue-500"
                          />
                        ) : (
                          p.name
                        )}
                      </td>
                      <td className="px-6 py-3">
                        {isEditing ? (
                          <input
                            value={editDraft.department}
                            onChange={(e) => setEditDraft((prev) => ({ ...prev, department: e.target.value }))}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-100 outline-none focus:border-blue-500"
                          />
                        ) : p.department ? (
                          <span className="inline-flex items-center px-2 py-1 rounded-full bg-slate-700/70 text-slate-200 text-xs">
                            {p.department}
                          </span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        {isEditing ? (
                          <input
                            type="number"
                            min={0.1}
                            step={0.1}
                            value={editDraft.weight}
                            onChange={(e) => setEditDraft((prev) => ({ ...prev, weight: e.target.value }))}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-100 outline-none focus:border-blue-500"
                          />
                        ) : (
                          <span className="font-mono text-slate-200">{p.weight ?? 1}</span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        {isEditing ? (
                          <div className="flex items-center gap-3">
                            <button
                              className="text-blue-300 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                              onClick={() => void saveEdit(p.id)}
                              disabled={saving}
                            >
                              保存
                            </button>
                            <button className="text-slate-400 hover:underline" onClick={() => cancelEdit()}>
                              取消
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-3">
                            <button className="text-blue-300 hover:underline" onClick={() => openEdit(p)}>
                              编辑
                            </button>
                            <button
                              className="text-red-300 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                              onClick={() => void deleteOne(p.id)}
                              disabled={deletingId === p.id}
                            >
                              删除
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {total > limit ? (
          <div className="flex items-center justify-between px-6 py-3 bg-slate-900/40 border-t border-slate-700">
            <div className="text-xs text-slate-500">
              第 {page} / {totalPages} 页
            </div>
            <div className="flex items-center gap-3">
              <button
                className="px-3 py-1 rounded border border-slate-700 text-slate-200 hover:bg-slate-700/40 disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                Prev
              </button>
              <button
                className="px-3 py-1 rounded border border-slate-700 text-slate-200 hover:bg-slate-700/40 disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {showImport ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
          onClick={() => setShowImport(false)}
        >
          <div
            className="w-full max-w-2xl rounded-xl bg-slate-900 border border-slate-700 shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-lg font-bold text-white">导入名单</h3>
                <p className="text-xs text-slate-400 mt-1">支持 xlsx/xls/csv/txt；导入后可在此页直接编辑/删除。</p>
              </div>
              <button className="text-slate-400 hover:text-white" onClick={() => setShowImport(false)}>
                ✕
              </button>
            </div>

            <div className="rounded-lg bg-slate-800 border border-slate-700 p-4">
              <ImportParticipants
                eventId={eventId}
                onUploadSuccess={() => {
                  setShowImport(false)
                  setPage(1)
                  void loadPage({ page: 1 })
                  void loadOverallTotal()
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
