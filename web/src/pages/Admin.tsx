import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiJson } from '../api'
import { ParticipantManager } from '../components/ParticipantManager'
import { friendlyErrorMessage } from '../friendlyError'
import { exportResultsToExcel } from '../exportResults'

type TabKey = 'control' | 'settings' | 'data' | 'results'

type EventSummary = {
  id: string
  name: string
  createdAt: string
}

type Prize = {
  id: string
  name: string
  level: number
  quantity: number
  allowRepeat: boolean
  drawnCount: number
  mediaUrl: string
}

type PrizeDraft = {
  name: string
  level: number
  quantity: number
  allowRepeat: boolean
}

type Winner = {
  id: string
  name: string
  department: string
}

type ResultItem = {
  id: string
  drawRunId: string
  prizeName: string
  participantName: string
  employeeId: string
  department: string
  timestamp: string
  isDeleted: boolean
  deletedAt?: string | null
}

type StageStatus = {
  state: 'IDLE' | 'ROLLING' | 'REVEAL'
  prizeName?: string
  drawRunId?: string
}

type StageEffects = {
  confettiEnabled: boolean
  confettiIntensity: number
  theme: 'gold' | 'festive' | 'simple'
}

const DEFAULT_STAGE_EFFECTS: StageEffects = {
  confettiEnabled: true,
  confettiIntensity: 1,
  theme: 'gold',
}

function isMp4(url: string): boolean {
  const clean = url.split('?')[0] ?? ''
  return clean.toLowerCase().endsWith('.mp4')
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function parseStageEffects(raw: unknown): StageEffects {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_STAGE_EFFECTS
  const rec = raw as Record<string, unknown>
  const next: StageEffects = { ...DEFAULT_STAGE_EFFECTS }
  if (typeof rec.confettiEnabled === 'boolean') next.confettiEnabled = rec.confettiEnabled
  if (typeof rec.confettiIntensity === 'number') next.confettiIntensity = clampNumber(rec.confettiIntensity, 0.5, 2.0)
  if (rec.theme === 'gold' || rec.theme === 'festive' || rec.theme === 'simple') next.theme = rec.theme
  return next
}

function TabButton(props: { active: boolean; icon: string; label: string; onClick: () => void }) {
  const { active, icon, label, onClick } = props
  return (
    <button
      onClick={onClick}
      className={[
        'w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all',
        active ? 'bg-blue-600 text-white shadow-lg' : 'hover:bg-slate-700 text-slate-200',
      ].join(' ')}
    >
      <span className="opacity-90">{icon}</span>
      <span className="font-semibold">{label}</span>
    </button>
  )
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function sanitizeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_')
}

export function AdminPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('control')
  const [error, setError] = useState<string>('')

  const [events, setEvents] = useState<EventSummary[]>([])
  const [eventId, setEventId] = useState<string>(() => localStorage.getItem('lottery_last_event_id') ?? '')
  const [eventName, setEventName] = useState('年会抽奖')
  const [newEventName, setNewEventName] = useState('年会抽奖')

  const [prizeName, setPrizeName] = useState('一等奖')
  const [prizeLevel, setPrizeLevel] = useState(1)
  const [prizeQuantity, setPrizeQuantity] = useState(1)
  const [prizeAllowRepeat, setPrizeAllowRepeat] = useState(false)

  const [prizes, setPrizes] = useState<Prize[]>([])
  const [prizeId, setPrizeId] = useState<string>('')
  const [prizeDrafts, setPrizeDrafts] = useState<Record<string, PrizeDraft>>({})

  const [drawCount, setDrawCount] = useState(1)
  const [winners, setWinners] = useState<Winner[]>([])

  const [stageState, setStageState] = useState<StageStatus['state']>('IDLE')

  const [backgroundUrl, setBackgroundUrl] = useState<string>('')
  const [bgmReadyUrl, setBgmReadyUrl] = useState<string>('')
  const [bgmRollingUrl, setBgmRollingUrl] = useState<string>('')
  const [bgmWinUrl, setBgmWinUrl] = useState<string>('')
  const [stageEffects, setStageEffects] = useState<StageEffects>(() => DEFAULT_STAGE_EFFECTS)
  const [results, setResults] = useState<ResultItem[]>([])
  const [showDeleted, setShowDeleted] = useState(false)
  const [resultsLoading, setResultsLoading] = useState(false)

  const stageUrl = eventId ? `/stage/${eventId}` : ''
  const stageControlUrl = eventId ? `/stage/${eventId}?control=1` : ''
  const selectedPrize = useMemo(() => prizes.find((p) => p.id === prizeId) ?? null, [prizes, prizeId])
  const selectedEventSummary = useMemo(() => events.find((e) => e.id === eventId) ?? null, [events, eventId])
  const selectedPrizeRemaining = useMemo(() => {
    if (!selectedPrize) return 0
    return Math.max(0, selectedPrize.quantity - selectedPrize.drawnCount)
  }, [selectedPrize])
  const isRolling = stageState === 'ROLLING'

  const lastPrizeIdForDrawCountRef = useRef<string>('')
  const prizeLevelTouchedRef = useRef(false)
  const stageEffectsSaveTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!prizeId) return

    const current = prizes.find((p) => p.id === prizeId)
    if (!current) return

    const remaining = Math.max(0, current.quantity - current.drawnCount)

    if (prizeId !== lastPrizeIdForDrawCountRef.current) {
      lastPrizeIdForDrawCountRef.current = prizeId
      setDrawCount(remaining > 0 ? remaining : 0)
      return
    }

    setDrawCount((prev) => {
      if (remaining <= 0) return 0
      if (prev < 1) return 1
      return prev > remaining ? remaining : prev
    })
  }, [prizeId, prizes])

  const statusText = useMemo(() => {
    if (!eventId) return 'SETUP'
    if (!prizeId) return 'WAIT_PRIZE'
    return 'READY'
  }, [eventId, prizeId])

  const loadResults = useCallback(async () => {
    if (!eventId) return
    setResultsLoading(true)
    try {
      const data = await apiJson<{ results: ResultItem[] }>(
        `/api/v1/events/${eventId}/results?includeDeleted=${showDeleted ? 'true' : 'false'}`,
      )
      const list = data.results ?? []
      setResults(showDeleted ? list.filter((r) => r.isDeleted) : list.filter((r) => !r.isDeleted))
    } finally {
      setResultsLoading(false)
    }
  }, [eventId, showDeleted])

  const refreshEvents = useCallback(async () => {
    const data = await apiJson<{ events: Array<{ id: string; name: string; createdAt: string }> }>('/api/v1/events')
    setEvents(data.events.map((e) => ({ id: e.id, name: e.name, createdAt: e.createdAt })))
  }, [])

  const loadEventDetail = useCallback(async () => {
    if (!eventId) return
    const data = await apiJson<{ event: { name: string; settingsJson: string } }>(`/api/v1/events/${eventId}`)
    setEventName(data.event.name)

    try {
      const settings = JSON.parse(data.event.settingsJson || '{}') as Record<string, unknown>
      const bg = settings.backgroundUrl
      setBackgroundUrl(typeof bg === 'string' ? bg : '')
      const readyUrl = settings.bgmReadyUrl
      const rollingUrl = settings.bgmRollingUrl
      const winUrl = settings.bgmWinUrl
      setBgmReadyUrl(typeof readyUrl === 'string' ? readyUrl : '')
      setBgmRollingUrl(typeof rollingUrl === 'string' ? rollingUrl : '')
      setBgmWinUrl(typeof winUrl === 'string' ? winUrl : '')
      setStageEffects(parseStageEffects(settings.stageEffects))
    } catch {
      setBackgroundUrl('')
      setBgmReadyUrl('')
      setBgmRollingUrl('')
      setBgmWinUrl('')
      setStageEffects(DEFAULT_STAGE_EFFECTS)
    }
  }, [eventId])

  const loadPrizes = useCallback(
    async (nextPrizeId?: string) => {
      if (!eventId) return
      const data = await apiJson<{
        prizes: Array<{ id: string; name: string; level: number; quantity: number; allowRepeat: boolean; drawnCount: number; mediaUrl?: string }>
      }>(
        `/api/v1/events/${eventId}/prizes`,
      )

      const nextPrizes = data.prizes.map((p) => ({
        id: p.id,
        name: p.name,
        level: p.level ?? 0,
        quantity: p.quantity,
        allowRepeat: p.allowRepeat,
        drawnCount: p.drawnCount ?? 0,
        mediaUrl: p.mediaUrl ?? '',
      }))
      setPrizes(nextPrizes)
      setPrizeDrafts(() => {
        const draft: Record<string, PrizeDraft> = {}
        for (const p of nextPrizes) draft[p.id] = { name: p.name, level: p.level, quantity: p.quantity, allowRepeat: p.allowRepeat }
        return draft
      })

      const maxLevel = nextPrizes.reduce((acc, p) => (Number.isFinite(p.level) && p.level > acc ? p.level : acc), 0)
      const suggested = Math.max(1, Math.floor(maxLevel) + 1)
      setPrizeLevel((prev) => {
        if (prizeLevelTouchedRef.current) return prev
        return suggested
      })

      const candidate = nextPrizeId ?? prizeId
      if (candidate && data.prizes.some((p) => p.id === candidate)) {
        setPrizeId(candidate)
        return
      }

      setPrizeId(data.prizes[0]?.id ?? '')
    },
    [eventId, prizeId],
  )

  const selectEvent = useCallback((nextEventId: string) => {
    setError('')
    setWinners([])
    setPrizes([])
    setPrizeId('')
    setPrizeDrafts({})
    prizeLevelTouchedRef.current = false
    setPrizeLevel(1)
    setBackgroundUrl('')
    setBgmReadyUrl('')
    setBgmRollingUrl('')
    setBgmWinUrl('')
    setStageEffects(DEFAULT_STAGE_EFFECTS)
    if (stageEffectsSaveTimerRef.current) {
      window.clearTimeout(stageEffectsSaveTimerRef.current)
      stageEffectsSaveTimerRef.current = null
    }
    setEventId(nextEventId)
  }, [])

  const deleteEventById = useCallback(
    async (targetEventId: string, targetEventName?: string) => {
      if (!targetEventId) return

      const name = targetEventName || events.find((e) => e.id === targetEventId)?.name || targetEventId
      const ok = window.confirm(
        `⚠️ 危险操作：确定要彻底删除活动 “${name}” 吗？\n\n将连带删除：\n- 所有奖项\n- 所有名单\n- 所有抽奖记录/结果\n- 舞台状态\n\n此操作不可恢复。`,
      )
      if (!ok) return

      await apiJson(`/api/v1/events/${targetEventId}`, { method: 'DELETE' })
      await refreshEvents()

      if (targetEventId === eventId) {
        localStorage.removeItem('lottery_last_event_id')
        selectEvent('')
        setActiveTab('settings')
      }
    },
    [eventId, events, refreshEvents, selectEvent],
  )

  const onDeleteCurrentEvent = useCallback(async () => {
    if (!eventId) return
    await deleteEventById(eventId, selectedEventSummary?.name || eventName || eventId)
  }, [deleteEventById, eventId, eventName, selectedEventSummary])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        await refreshEvents()
      } catch (e) {
        if (cancelled) return
        setError(friendlyErrorMessage(e))
      }
    }
    void run()

    return () => {
      cancelled = true
    }
  }, [refreshEvents])

  useEffect(() => {
    if (!eventId) return
    localStorage.setItem('lottery_last_event_id', eventId)
  }, [eventId])

  useEffect(() => {
    if (!eventId) return

    let cancelled = false
    void (async () => {
      try {
        await loadEventDetail()
        await loadPrizes()
        if (cancelled) return
        setError('')
      } catch (e) {
        if (cancelled) return
        setError(friendlyErrorMessage(e))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [eventId, loadEventDetail, loadPrizes])

  useEffect(() => {
    if (activeTab !== 'results') return
    if (!eventId) {
      setResults([])
      return
    }

    let cancelled = false
    void (async () => {
      try {
        await loadResults()
        if (cancelled) return
        setError('')
      } catch (e) {
        if (cancelled) return
        setError(friendlyErrorMessage(e))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeTab, eventId, loadResults])

  useEffect(() => {
    if (activeTab !== 'control') return
    if (!eventId) {
      setStageState('IDLE')
      return
    }

    let cancelled = false
    const poll = async () => {
      try {
        const data = await apiJson<StageStatus>(`/api/v1/events/${eventId}/status`)
        if (cancelled) return
        setStageState(data.state)
      } catch {
        // keep last known state: control UI shouldn't flicker on transient errors
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [activeTab, eventId])

  async function onCreateEvent() {
    setError('')
    const data = await apiJson<{ event: { id: string } }>('/api/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newEventName }),
    })
    await refreshEvents()
    selectEvent(data.event.id)
    setActiveTab('settings')
  }

  async function onCreatePrize() {
    if (!eventId) return
    setError('')
    setWinners([])
    const data = await apiJson<{ prize: { id: string } }>(`/api/v1/events/${eventId}/prizes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: prizeName, level: prizeLevel, quantity: prizeQuantity, allowRepeat: prizeAllowRepeat }),
    })
    await loadPrizes(data.prize.id)
  }

  async function onUpdatePrize(id: string) {
    if (!eventId) return
    const draft = prizeDrafts[id]
    if (!draft) return

    setError('')
    await apiJson(`/api/v1/events/${eventId}/prizes/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: draft.name, level: draft.level, quantity: draft.quantity, allowRepeat: draft.allowRepeat }),
    })
    await loadPrizes(id)
  }

  async function onDraw() {
    if (!eventId || !prizeId) return
    setError('')
    const data = await apiJson<{ winners: Winner[] }>(`/api/v1/events/${eventId}/draw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prizeId, count: drawCount }),
    })
    setWinners(data.winners)
    await loadPrizes(prizeId)
    setStageState('REVEAL')
  }

  async function onStartRolling() {
    if (!eventId || !prizeId) return
    setError('')
    setWinners([])
    await apiJson(`/api/v1/events/${eventId}/start-rolling`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prizeId }),
    })
    setStageState('ROLLING')
  }

  async function onToggleRolling() {
    if (!eventId || !prizeId) return
    if (isRolling) {
      await onDraw()
      return
    }
    await onStartRolling()
  }

  async function onExportResults() {
    if (!eventId) return
    setError('')
    await exportResultsToExcel(eventId, eventName)
  }

  async function onExportDeletedResults() {
    if (!eventId) return
    setError('')
    await exportResultsToExcel(eventId, eventName, { onlyDeleted: true, filenameSuffix: '回收站' })
  }

  async function onToggleResult(id: string, isDeleted: boolean) {
    if (!eventId) return
    setError('')
    const action = isDeleted ? 'restore' : 'delete'
    await apiJson(`/api/v1/results/${id}/${action}`, { method: 'PUT' })
    await loadResults()
    await loadPrizes()
  }

  async function onResetEventResults() {
    if (!eventId) return
    const ok = window.confirm('⚠️ 高危操作：确定要把【本活动】所有“有效中奖记录”移入回收站吗？\n\n用途：彩排结束后，正式开始前一键清空。\n\n（可在回收站里恢复/导出）')
    if (!ok) return

    setError('')
    setWinners([])
    await apiJson(`/api/v1/events/${eventId}/reset`, { method: 'POST' })
    await loadResults()
    await loadPrizes()
  }

  async function onExportEventConfig() {
    if (!eventId) return
    setError('')
    const data = await apiJson<{ bundle: unknown }>(`/api/v1/events/${eventId}/export`)
    downloadJson(`${sanitizeFilename(eventName)}_配置.json`, data.bundle)
  }

  async function onImportEventConfig(file: File) {
    setError('')
    const raw = await file.text()
    const parsed = JSON.parse(raw) as unknown
    const bundle =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'bundle' in (parsed as Record<string, unknown>)
        ? (parsed as Record<string, unknown>).bundle
        : parsed

    const data = await apiJson<{ event: { id: string } }>(`/api/v1/events/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle }),
    })
    await refreshEvents()
    selectEvent(data.event.id)
    setActiveTab('settings')
  }

  async function onUploadBackground(file: File) {
    if (!eventId) return
    setError('')
    const form = new FormData()
    form.append('file', file)
    const data = await apiJson<{ url: string }>(`/api/v1/events/${eventId}/background`, { method: 'POST', body: form })
    setBackgroundUrl(data.url)
  }

  async function onUploadBgm(slot: 'ready' | 'rolling' | 'win', file: File) {
    if (!eventId) return
    setError('')
    const form = new FormData()
    form.append('file', file)
    const data = await apiJson<{ url: string }>(`/api/v1/events/${eventId}/bgm/${slot}`, { method: 'POST', body: form })
    if (slot === 'ready') setBgmReadyUrl(data.url)
    if (slot === 'rolling') setBgmRollingUrl(data.url)
    if (slot === 'win') setBgmWinUrl(data.url)
  }

  async function onUploadPrizeMedia(prizeIdToUpload: string, file: File) {
    if (!eventId) return
    setError('')
    const form = new FormData()
    form.append('file', file)
    await apiJson(`/api/v1/events/${eventId}/prizes/${prizeIdToUpload}/media`, { method: 'POST', body: form })
    await loadPrizes(prizeIdToUpload)
  }

  const scheduleStageEffectsSave = useCallback(
    (next: StageEffects, delayMs: number) => {
      if (!eventId) return
      if (stageEffectsSaveTimerRef.current) window.clearTimeout(stageEffectsSaveTimerRef.current)
      stageEffectsSaveTimerRef.current = window.setTimeout(() => {
        void apiJson(`/api/v1/events/${eventId}/stage-effects`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stageEffects: next }),
        }).catch((e) => setError(friendlyErrorMessage(e)))
      }, delayMs)
    },
    [eventId],
  )

  const updateStageEffects = useCallback(
    (patch: Partial<StageEffects>, debounceMs: number) => {
      const next: StageEffects = { ...stageEffects, ...patch }
      setStageEffects(next)
      scheduleStageEffectsSave(next, debounceMs)
    },
    [scheduleStageEffectsSave, stageEffects],
  )

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans flex">
      <aside className="w-72 bg-slate-800 border-r border-slate-700 flex flex-col">
        <div className="p-6 border-b border-slate-700">
          <h1 className="text-2xl font-extrabold text-white tracking-wider">年会中控台</h1>
          <p className="text-xs text-slate-400 mt-1">Lottery Console · MVP</p>
        </div>

        <div className="p-4 border-b border-slate-700 space-y-2">
          <div className="text-xs text-slate-400">当前活动</div>
          <select
            className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-white text-sm outline-none focus:border-blue-500"
            value={eventId}
            onChange={(e) => selectEvent(e.target.value)}
          >
            <option value="">（请选择活动）</option>
            {selectedEventSummary ? null : eventId ? <option value={eventId}>（已选择：{eventId.slice(0, 8)}…）</option> : null}
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
              </option>
            ))}
          </select>
          <button
            className="w-full px-3 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm"
            onClick={() => refreshEvents().catch((e) => setError(friendlyErrorMessage(e)))}
          >
            刷新活动列表
          </button>
          <button
            className="w-full px-3 py-2 bg-red-900/40 border border-red-800 rounded text-red-200 hover:bg-red-900/60 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!eventId}
            onClick={() => onDeleteCurrentEvent().catch((e) => setError(friendlyErrorMessage(e)))}
          >
            删除当前活动
          </button>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <TabButton active={activeTab === 'control'} icon="▶" label="现场总控" onClick={() => setActiveTab('control')} />
          <TabButton active={activeTab === 'settings'} icon="⚙" label="活动配置" onClick={() => setActiveTab('settings')} />
          <TabButton active={activeTab === 'data'} icon="≡" label="名单与数据" onClick={() => setActiveTab('data')} />
          <TabButton active={activeTab === 'results'} icon="🗑" label="结果与回收站" onClick={() => setActiveTab('results')} />
        </nav>

        <div className="p-4 border-t border-slate-700 space-y-2">
          {eventId ? (
            <>
              <div className="text-xs text-slate-400">eventId</div>
              <div className="font-mono text-xs break-all">{eventId}</div>
            </>
          ) : (
            <div className="text-xs text-slate-400">先创建/导入活动再打开舞台</div>
          )}

          <a
            href={stageUrl || '#'}
            target="_blank"
            rel="noreferrer"
            className={[
              'block w-full text-center py-2 rounded border transition-colors',
              eventId ? 'border-slate-500 text-slate-200 hover:border-white hover:text-white' : 'border-slate-700 text-slate-500 cursor-not-allowed',
            ].join(' ')}
            onClick={(e) => {
              if (!eventId) e.preventDefault()
            }}
          >
            ↗ 打开舞台大屏
          </a>
          <a
            href={stageControlUrl || '#'}
            target="_blank"
            rel="noreferrer"
            className={[
              'block w-full text-center py-2 rounded border transition-colors text-sm',
              eventId ? 'border-slate-700 text-slate-400 hover:border-white hover:text-white' : 'border-slate-800 text-slate-600 cursor-not-allowed',
            ].join(' ')}
            onClick={(e) => {
              if (!eventId) e.preventDefault()
            }}
          >
            ↗ 单屏模式（舞台可控）
          </a>
        </div>
      </aside>

      <main className="flex-1 p-8 overflow-y-auto">
        <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-8 border-b border-slate-700 pb-4">
          <div>
            <h2 className="text-3xl font-extrabold text-white">{eventId ? eventName : '未选择活动'}</h2>
            <p className="text-slate-400 mt-1">
              当前状态: <span className="text-green-400 font-mono">{statusText}</span>
            </p>
          </div>

          <div className="flex gap-3">
            <button
              className="px-4 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm"
              onClick={() => {
                localStorage.removeItem('lottery_last_event_id')
                selectEvent('')
                setActiveTab('settings')
              }}
            >
              清空本地状态
            </button>
            <button
              className="px-4 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => onExportResults().catch((e) => setError(friendlyErrorMessage(e)))}
              disabled={!eventId}
            >
              导出结果
            </button>
          </div>
        </header>

        {error ? (
          <div className="mb-6 rounded-lg border border-red-700 bg-red-950/40 px-4 py-3 text-red-200">
            <strong className="mr-2">错误</strong>
            <span className="font-mono text-sm whitespace-pre-wrap">{error}</span>
          </div>
        ) : null}

        {activeTab === 'settings' ? (
          <div className="grid grid-cols-12 gap-6">
            <div className="col-span-12 lg:col-span-7 space-y-6">
              <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
                <h3 className="text-xl font-bold text-white mb-4">活动</h3>
                <div className="flex flex-col md:flex-row gap-3">
                  <input
                    className="flex-1 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-white outline-none focus:border-blue-500"
                    value={newEventName}
                    onChange={(e) => setNewEventName(e.target.value)}
                    placeholder="活动名称"
                  />
                  <button
                    className="px-4 py-2 bg-blue-600 rounded text-white font-semibold hover:bg-blue-500"
                    onClick={() => onCreateEvent().catch((e) => setError(friendlyErrorMessage(e)))}
                  >
                    创建活动
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-12 gap-3">
                  <button
                    className="col-span-12 md:col-span-6 px-4 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                    onClick={() => onExportEventConfig().catch((e) => setError(friendlyErrorMessage(e)))}
                    disabled={!eventId}
                  >
                    导出活动配置（JSON）
                  </button>
                  <label className="col-span-12 md:col-span-6 px-4 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm cursor-pointer text-center">
                    导入活动配置（JSON）
                    <input
                      type="file"
                      className="hidden"
                      accept="application/json,.json"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (!f) return
                        onImportEventConfig(f).catch((err) => setError(friendlyErrorMessage(err)))
                      }}
                    />
                  </label>
                </div>
                <p className="text-xs text-slate-400 mt-3">
                  导入会创建<strong className="text-slate-200">新的活动</strong>（新 eventId），包含奖项与名单；媒体文件需自行拷贝{' '}
                  <span className="font-mono">uploads/</span>。
                </p>
              </div>

              <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
                <h3 className="text-xl font-bold text-white mb-4">奖项（可连建 / 可编辑）</h3>
                <div className="grid grid-cols-12 gap-3">
                  <input
                    className="col-span-12 md:col-span-5 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-white outline-none focus:border-blue-500"
                    value={prizeName}
                    onChange={(e) => setPrizeName(e.target.value)}
                    placeholder="奖项名称"
                    disabled={!eventId}
                  />
                  <input
                    className="col-span-6 md:col-span-2 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-white outline-none focus:border-blue-500"
                    type="number"
                    value={prizeLevel}
                    min={1}
                    onChange={(e) => {
                      prizeLevelTouchedRef.current = true
                      setPrizeLevel(Number(e.target.value))
                    }}
                    disabled={!eventId}
                    title="数字越大越先抽（一般：三等奖=3，二等奖=2，一等奖=1）"
                    placeholder="Level"
                  />
                  <input
                    className="col-span-6 md:col-span-2 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-white outline-none focus:border-blue-500"
                    type="number"
                    value={prizeQuantity}
                    onChange={(e) => setPrizeQuantity(Number(e.target.value))}
                    disabled={!eventId}
                    min={1}
                  />
                  <label className="col-span-12 md:col-span-3 flex items-center gap-2 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm">
                    <input type="checkbox" checked={prizeAllowRepeat} onChange={(e) => setPrizeAllowRepeat(e.target.checked)} disabled={!eventId} />
                    <span className="text-slate-300">允许重复中奖</span>
                  </label>
                  <button
                    className="col-span-12 md:col-span-3 px-4 py-2 bg-blue-600 rounded text-white font-semibold hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
                    onClick={() => onCreatePrize().catch((e) => setError(friendlyErrorMessage(e)))}
                    disabled={!eventId}
                  >
                    创建奖项
                  </button>
                </div>
                <p className="text-xs text-slate-400 mt-3">
                  顺序（Level）：数字越大越先抽（一般：三等奖=3，二等奖=2，一等奖=1）。其中 <span className="font-mono">Level=1</span> 会触发舞台页「尊贵模式」展示。
                </p>

                <div className="mt-5 space-y-3">
                  {prizes.length === 0 ? (
                    <div className="text-sm text-slate-500">（暂无奖项）</div>
                  ) : (
                    prizes.map((p) => {
                      const draft = prizeDrafts[p.id] ?? { name: p.name, level: p.level, quantity: p.quantity, allowRepeat: p.allowRepeat }
                      return (
                        <div key={p.id} className="grid grid-cols-12 gap-3 items-center bg-slate-900/40 border border-slate-700 rounded-lg p-3">
                          <input
                            className="col-span-12 md:col-span-5 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-white outline-none focus:border-blue-500"
                            value={draft.name}
                            onChange={(e) => setPrizeDrafts((prev) => ({ ...prev, [p.id]: { ...draft, name: e.target.value } }))}
                            disabled={!eventId}
                          />
                          <input
                            className="col-span-6 md:col-span-2 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-white outline-none focus:border-blue-500"
                            type="number"
                            value={draft.level}
                            onChange={(e) => setPrizeDrafts((prev) => ({ ...prev, [p.id]: { ...draft, level: Number(e.target.value) } }))}
                            disabled={!eventId}
                            min={1}
                            title="数字越大越先抽（一般：三等奖=3，二等奖=2，一等奖=1）"
                          />
                          <input
                            className="col-span-6 md:col-span-2 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-white outline-none focus:border-blue-500"
                            type="number"
                            min={1}
                            value={draft.quantity}
                            onChange={(e) => setPrizeDrafts((prev) => ({ ...prev, [p.id]: { ...draft, quantity: Number(e.target.value) } }))}
                            disabled={!eventId}
                          />
                          <label className="col-span-6 md:col-span-2 flex items-center gap-2 text-sm text-slate-300">
                            <input
                              type="checkbox"
                              checked={draft.allowRepeat}
                              onChange={(e) => setPrizeDrafts((prev) => ({ ...prev, [p.id]: { ...draft, allowRepeat: e.target.checked } }))}
                              disabled={!eventId}
                            />
                            重复
                          </label>
                          <button
                            className="col-span-6 md:col-span-1 px-3 py-2 bg-slate-700 rounded text-white text-sm hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
                            onClick={() => onUpdatePrize(p.id).catch((e) => setError(friendlyErrorMessage(e)))}
                            disabled={!eventId}
                          >
                            保存
                          </button>

                          <div className="col-span-12 flex flex-wrap items-center gap-3 pt-3 border-t border-slate-700/60">
                            <div className="w-28 h-16 bg-black/40 border border-slate-700 rounded overflow-hidden flex items-center justify-center text-xs text-slate-500">
                              {p.mediaUrl ? (
                                isMp4(p.mediaUrl) ? (
                                  <video src={p.mediaUrl} muted autoPlay loop playsInline className="w-full h-full object-cover opacity-90" />
                                ) : (
                                  <img src={p.mediaUrl} className="w-full h-full object-cover opacity-90" />
                                )
                              ) : (
                                '无奖品媒体'
                              )}
                            </div>

                            <label className="px-3 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
                              上传奖品图/视频
                              <input
                                type="file"
                                className="hidden"
                                accept="image/*,video/mp4"
                                onChange={(e) => {
                                  const f = e.target.files?.[0]
                                  e.target.value = ''
                                  if (!f) return
                                  onUploadPrizeMedia(p.id, f).catch((err) => setError(friendlyErrorMessage(err)))
                                }}
                                disabled={!eventId}
                              />
                            </label>

                            {p.mediaUrl ? (
                              <a
                                href={p.mediaUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-sm text-slate-300 hover:text-white underline underline-offset-4"
                              >
                                打开媒体 →
                              </a>
                            ) : null}

                            <div className="text-xs text-slate-500">舞台页会自动展示该奖品媒体。</div>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="col-span-12 lg:col-span-5 space-y-6">
              <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
                <h3 className="text-lg font-bold text-white mb-4">舞台背景（图片/MP4）</h3>
                <div className="aspect-video bg-black rounded overflow-hidden border border-slate-700 flex items-center justify-center text-slate-500">
                  {backgroundUrl ? (
                    isMp4(backgroundUrl) ? (
                      <video src={backgroundUrl} muted autoPlay loop playsInline className="w-full h-full object-cover opacity-90" />
                    ) : (
                      <img src={backgroundUrl} className="w-full h-full object-cover opacity-90" />
                    )
                  ) : (
                    '无信号'
                  )}
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <label className="px-4 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
                    更换背景
                    <input
                      type="file"
                      className="hidden"
                      accept="image/*,video/mp4"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (!f) return
                        onUploadBackground(f).catch((err) => setError(friendlyErrorMessage(err)))
                      }}
                      disabled={!eventId}
                    />
                  </label>
                  {stageUrl ? (
                    <a href={stageUrl} target="_blank" rel="noreferrer" className="text-sm text-slate-300 hover:text-white underline underline-offset-4">
                      预览舞台 →
                    </a>
                  ) : (
                    <span className="text-sm text-slate-500">先创建/导入活动</span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-3">上传后舞台页会通过 `/status` 自动刷新背景。</p>
              </div>

              <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
                <h3 className="text-lg font-bold text-white mb-2">舞台音乐（BGM）</h3>
                <p className="text-xs text-slate-400 mb-4">
                  Ready/Rolling/Reveal 三段音乐，舞台页会自动淡入淡出切换（≤50MB，audio/*）。
                </p>

                <div className="space-y-3">
                  <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-3 flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm text-white font-semibold">暖场音乐（READY）</div>
                        <div className="text-xs text-slate-500">{bgmReadyUrl ? '已配置' : '未配置'}</div>
                      </div>
                      <label className="px-3 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
                        上传
                        <input
                          type="file"
                          className="hidden"
                          accept="audio/*"
                          onChange={(e) => {
                            const f = e.target.files?.[0]
                            e.target.value = ''
                            if (!f) return
                            onUploadBgm('ready', f).catch((err) => setError(friendlyErrorMessage(err)))
                          }}
                          disabled={!eventId}
                        />
                      </label>
                    </div>
                    {bgmReadyUrl ? <audio controls preload="metadata" src={bgmReadyUrl} className="w-full" /> : null}
                  </div>

                  <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-3 flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm text-white font-semibold">紧张音乐（ROLLING）</div>
                        <div className="text-xs text-slate-500">{bgmRollingUrl ? '已配置' : '未配置'}</div>
                      </div>
                      <label className="px-3 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
                        上传
                        <input
                          type="file"
                          className="hidden"
                          accept="audio/*"
                          onChange={(e) => {
                            const f = e.target.files?.[0]
                            e.target.value = ''
                            if (!f) return
                            onUploadBgm('rolling', f).catch((err) => setError(friendlyErrorMessage(err)))
                          }}
                          disabled={!eventId}
                        />
                      </label>
                    </div>
                    {bgmRollingUrl ? <audio controls preload="metadata" src={bgmRollingUrl} className="w-full" /> : null}
                  </div>

                  <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-3 flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm text-white font-semibold">颁奖音乐（REVEAL）</div>
                        <div className="text-xs text-slate-500">{bgmWinUrl ? '已配置' : '未配置'}</div>
                      </div>
                      <label className="px-3 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
                        上传
                        <input
                          type="file"
                          className="hidden"
                          accept="audio/*"
                          onChange={(e) => {
                            const f = e.target.files?.[0]
                            e.target.value = ''
                            if (!f) return
                            onUploadBgm('win', f).catch((err) => setError(friendlyErrorMessage(err)))
                          }}
                          disabled={!eventId}
                        />
                      </label>
                    </div>
                    {bgmWinUrl ? <audio controls preload="metadata" src={bgmWinUrl} className="w-full" /> : null}
                  </div>
                </div>

                <p className="text-xs text-slate-500 mt-4">
                  备注：抽奖音效（SFX）仍从 <span className="font-mono">web/public/assets/rolling.mp3</span> 与{' '}
                  <span className="font-mono">web/public/assets/win.mp3</span> 读取；舞台首次点击会解锁音频，右上角 MIX 可分别调 BGM/SFX。
                </p>
              </div>

              <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
                <h3 className="text-lg font-bold text-white mb-2">舞台特效</h3>
                <p className="text-xs text-slate-400 mb-4">用于适配不同现场设备：老旧 LED 屏可降低强度或直接关闭。</p>

                <div className="space-y-3">
                  <label className="bg-slate-900/40 border border-slate-700 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm text-white font-semibold">纸屑特效</div>
                      <div className="text-xs text-slate-500">开奖瞬间喷射五彩纸屑</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={stageEffects.confettiEnabled}
                      onChange={(e) => updateStageEffects({ confettiEnabled: e.target.checked }, 0)}
                      disabled={!eventId}
                      className="h-5 w-5 accent-yellow-400 disabled:opacity-40"
                    />
                  </label>

                  <div className="bg-slate-900/40 border border-slate-700 rounded-lg px-4 py-3">
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-sm text-white font-semibold">纸屑密度</div>
                      <div className="text-xs text-slate-500">{Math.round(stageEffects.confettiIntensity * 100)}%</div>
                    </div>
                    <input
                      type="range"
                      min={50}
                      max={200}
                      step={5}
                      value={Math.round(stageEffects.confettiIntensity * 100)}
                      onChange={(e) => updateStageEffects({ confettiIntensity: Number(e.target.value) / 100 }, 250)}
                      disabled={!eventId || !stageEffects.confettiEnabled}
                      className="w-full mt-2 disabled:opacity-40"
                    />
                    <div className="mt-1 flex justify-between text-xs text-slate-600">
                      <span>微量</span>
                      <span>暴雨</span>
                    </div>
                  </div>

                  <div className="bg-slate-900/40 border border-slate-700 rounded-lg px-4 py-3">
                    <div className="text-sm text-white font-semibold mb-2">主题</div>
                    <select
                      value={stageEffects.theme}
                      onChange={(e) => updateStageEffects({ theme: e.target.value as StageEffects['theme'] }, 0)}
                      disabled={!eventId}
                      className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-white text-sm outline-none focus:border-yellow-400 disabled:opacity-40"
                    >
                      <option value="gold">金色奢华（金/白）</option>
                      <option value="festive">多彩节日（彩虹）</option>
                      <option value="simple">品牌简约（蓝/白）</option>
                    </select>
                  </div>
                </div>

                <p className="text-xs text-slate-500 mt-4">提示：舞台端每秒轮询，会在 1 秒内应用新的特效参数。</p>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === 'control' ? (
          <div className="grid grid-cols-12 gap-6">
            <div className="col-span-12 lg:col-span-8 space-y-6">
              <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
                  <h3 className="text-xl font-bold text-white">正在抽取</h3>
                  <div className="flex items-center gap-3">
                    <select
                      className="bg-slate-900 border border-slate-600 rounded px-3 py-2 text-white text-sm outline-none focus:border-blue-500 disabled:opacity-40"
                      value={prizeId}
                      onChange={(e) => {
                        const nextId = e.target.value
                        setPrizeId(nextId)
                        const next = prizes.find((p) => p.id === nextId)
                        if (!next) return
                        const remaining = Math.max(0, next.quantity - next.drawnCount)
                        setDrawCount(remaining > 0 ? remaining : 0)
                      }}
                      disabled={!eventId || prizes.length === 0 || isRolling}
                    >
                      {prizes.length === 0 ? <option value="">（暂无奖项）</option> : null}
                      {prizes.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}（剩余 {Math.max(0, p.quantity - p.drawnCount)}/{p.quantity}）
                        </option>
                      ))}
                    </select>
                    <input
                      className="w-24 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-white text-sm outline-none focus:border-blue-500 disabled:opacity-40"
                      type="number"
                      min={selectedPrizeRemaining > 0 ? 1 : 0}
                      max={selectedPrizeRemaining > 0 ? selectedPrizeRemaining : 0}
                      value={drawCount}
                      onChange={(e) => {
                        const raw = Number(e.target.value)
                        const v = Number.isFinite(raw) ? Math.floor(raw) : 0
                        if (selectedPrizeRemaining <= 0) {
                          setDrawCount(0)
                          return
                        }
                        setDrawCount(Math.max(1, Math.min(selectedPrizeRemaining, v)))
                      }}
                      disabled={!eventId || !prizeId || selectedPrizeRemaining <= 0 || isRolling}
                    />
                  </div>
                </div>

                <div className="bg-slate-900 rounded-lg p-8 flex flex-col items-center justify-center border border-slate-700 min-h-[220px]">
                  <p className="text-slate-500 mb-5">
                    当前奖项：<span className="text-slate-200 font-semibold">{selectedPrize?.name ?? '未选择'}</span>
                  </p>
                  <button
                    className={[
                      'w-56 h-56 rounded-full text-white text-2xl font-bold',
                      isRolling ? 'bg-gradient-to-br from-red-500 to-orange-600 animate-pulse scale-105' : 'bg-gradient-to-br from-blue-600 to-blue-800',
                      'shadow-[0_0_30px_rgba(220,38,38,0.45)] hover:scale-105 active:scale-95 transition-all',
                      !eventId || !prizeId || (!isRolling && (selectedPrizeRemaining <= 0 || drawCount < 1)) ? 'opacity-40 cursor-not-allowed' : '',
                    ].join(' ')}
                    onClick={() => onToggleRolling().catch((e) => setError(friendlyErrorMessage(e)))}
                    disabled={!eventId || !prizeId || (!isRolling && (selectedPrizeRemaining <= 0 || drawCount < 1))}
                  >
                    {isRolling ? '点击停止' : '开始抽奖'}
                  </button>
                  <p className="text-xs text-slate-400 mt-6 text-center">
                    {isRolling ? '控场模式：大屏会一直滚动，等你喊“停”再开奖。' : '控场模式：点击开始后，大屏会一直滚动，直到你点击“停止”。'}
                  </p>
                </div>
              </div>

              <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
                <h3 className="text-lg font-bold text-white mb-4">本轮中奖名单</h3>
                <div className="bg-slate-950 rounded p-4 h-44 overflow-y-auto font-mono text-sm">
                  {winners.length === 0 ? <div className="text-slate-600">（暂无）</div> : null}
                  {winners.map((w) => (
                    <div key={w.id} className="flex justify-between border-b border-slate-800 py-2 text-green-400">
                      <span>{w.name}</span>
                      <span className="text-slate-400">{w.department}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="col-span-12 lg:col-span-4 space-y-6">
              <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
                <h3 className="text-lg font-bold text-white mb-2">舞台联动</h3>
                <p className="text-xs text-slate-400">
                  Admin 点“开始抽奖” → 服务器标记为 ROLLING → Stage 开始无限滚动 → Admin 点“停止” → 服务器计算结果并切到 REVEAL → Stage 立刻定格开奖。
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <a
                    href={stageUrl || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className={[
                      'inline-block px-4 py-2 rounded border transition-colors',
                      eventId ? 'border-slate-500 text-slate-200 hover:border-white hover:text-white' : 'border-slate-700 text-slate-500 cursor-not-allowed',
                    ].join(' ')}
                    onClick={(e) => {
                      if (!eventId) e.preventDefault()
                    }}
                  >
                    打开舞台页
                  </a>
                  <a
                    href={stageControlUrl || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className={[
                      'inline-block px-4 py-2 rounded border transition-colors text-slate-300',
                      eventId ? 'border-slate-700 hover:border-white hover:text-white' : 'border-slate-800 text-slate-600 cursor-not-allowed',
                    ].join(' ')}
                    onClick={(e) => {
                      if (!eventId) e.preventDefault()
                    }}
                  >
                    单屏模式（舞台可控）
                  </a>
                </div>
              </div>

              <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
                <h3 className="text-lg font-bold text-white mb-2">快速入口</h3>
                <button
                  className="w-full px-4 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => loadPrizes().catch((e) => setError(friendlyErrorMessage(e)))}
                  disabled={!eventId}
                >
                  刷新奖项列表
                </button>
                <button
                  className="w-full mt-3 px-4 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => {
                    setActiveTab('data')
                  }}
                  disabled={!eventId}
                >
                  去导入名单 / 导出数据
                </button>
              </div>

              {events.length ? (
                <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
                  <h3 className="text-lg font-bold text-white mb-2">活动列表</h3>
                  <div className="text-xs text-slate-400 mb-3">刷新页面不会丢：会自动记住上次选择。</div>
                  <div className="space-y-2 max-h-80 overflow-auto pr-1">
                    {events.map((ev) => (
                      <div
                        key={ev.id}
                        className={[
                          'group relative w-full text-left px-3 py-2 rounded border text-sm cursor-pointer transition-colors',
                          ev.id === eventId
                            ? 'border-blue-500 bg-blue-950/40'
                            : 'border-slate-700 hover:bg-slate-700/60 hover:border-slate-600',
                        ].join(' ')}
                        onClick={() => selectEvent(ev.id)}
                      >
                        <div className="text-slate-100 font-semibold truncate pr-8">{ev.name}</div>
                        <div className="text-slate-500 font-mono text-xs truncate pr-8">{ev.id}</div>
                        <button
                          type="button"
                          title="删除此活动"
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-slate-500 hover:bg-red-900/60 hover:text-red-200 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteEventById(ev.id, ev.name).catch((err) => setError(friendlyErrorMessage(err)))
                          }}
                        >
                          🗑
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {activeTab === 'data' ? (
          <div className="space-y-6">
            {!eventId ? (
              <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6 text-slate-400">
                请先在「活动配置」创建/导入并选择一个活动。
              </div>
            ) : (
              <ParticipantManager eventId={eventId} />
            )}
          </div>
        ) : null}

        {activeTab === 'results' ? (
          <div className="space-y-6">
            {!eventId ? (
              <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6 text-slate-400">
                请先在「活动配置」创建/导入并选择一个活动。
              </div>
            ) : (
              <>
                <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl p-6">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div>
                      <h3 className="text-xl font-bold text-white">中奖结果管理</h3>
                      <p className="text-xs text-slate-400 mt-2">
                        用法：彩排抽出来的“测试结果”，直接移入回收站；正式抽奖时导出就干净了（解决舞台“幽灵开奖”）。
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-2 text-slate-300 cursor-pointer select-none text-sm">
                        <input
                          type="checkbox"
                          checked={showDeleted}
                          onChange={(e) => setShowDeleted(e.target.checked)}
                          className="rounded bg-slate-700 border-slate-600"
                        />
                        回收站模式（只看已删除）
                      </label>
                      <button
                        className="px-4 py-2 bg-red-900/50 border border-red-700 text-red-200 rounded hover:bg-red-900 transition-colors text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => onResetEventResults().catch((e) => setError(friendlyErrorMessage(e)))}
                        disabled={!eventId}
                      >
                        ☢️ 一键清空（移入回收站）
                      </button>
                      <button
                        className="px-4 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => onExportResults().catch((e) => setError(friendlyErrorMessage(e)))}
                        disabled={!eventId}
                      >
                        导出有效 Excel
                      </button>
                      <button
                        className="px-4 py-2 bg-slate-700 rounded hover:bg-slate-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => onExportDeletedResults().catch((e) => setError(friendlyErrorMessage(e)))}
                        disabled={!eventId}
                      >
                        导出回收站 Excel
                      </button>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl bg-slate-800 border border-slate-700 shadow-xl overflow-hidden">
                  <div className="overflow-auto">
                    <table className="w-full text-left text-sm text-slate-300">
                      <thead className="bg-slate-900 text-slate-400 uppercase font-bold">
                        <tr>
                          <th className="px-6 py-3">时间</th>
                          <th className="px-6 py-3">奖项</th>
                          <th className="px-6 py-3">姓名</th>
                          <th className="px-6 py-3">部门</th>
                          <th className="px-6 py-3">状态</th>
                          <th className="px-6 py-3">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700">
                        {resultsLoading ? (
                          <tr>
                            <td colSpan={6} className="px-6 py-8 text-center text-slate-500">
                              加载中…
                            </td>
                          </tr>
                        ) : results.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-6 py-10 text-center text-slate-500">
                              {showDeleted ? '回收站为空。' : '暂无有效中奖记录。'}
                            </td>
                          </tr>
                        ) : (
                          results.map((r) => (
                            <tr key={r.id} className={r.isDeleted ? 'bg-red-900/10 opacity-70' : 'hover:bg-slate-700/40'}>
                              <td className="px-6 py-3 font-mono text-slate-400">
                                {r.timestamp ? new Date(r.timestamp).toLocaleString() : '—'}
                              </td>
                              <td className="px-6 py-3 text-yellow-300 font-semibold">{r.prizeName || '—'}</td>
                              <td className="px-6 py-3 font-bold text-white">{r.participantName}</td>
                              <td className="px-6 py-3 text-slate-400">{r.department || '—'}</td>
                              <td className="px-6 py-3">
                                {r.isDeleted ? <span className="text-red-300">已删除</span> : <span className="text-green-300">有效</span>}
                              </td>
                              <td className="px-6 py-3">
                                <button
                                  className={['hover:underline', r.isDeleted ? 'text-blue-300' : 'text-red-300'].join(' ')}
                                  onClick={() => onToggleResult(r.id, r.isDeleted).catch((e) => setError(friendlyErrorMessage(e)))}
                                >
                                  {r.isDeleted ? '恢复' : '删除'}
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : null}
      </main>
    </div>
  )
}
