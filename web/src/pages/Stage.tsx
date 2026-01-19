import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiJson } from '../api'
import { WinnerReveal, type Winner } from '../components/WinnerReveal'
import { friendlyErrorMessage } from '../friendlyError'
import { useStageAudio } from '../hooks/useStageAudio'
import { useStageBgm } from '../hooks/useStageBgm'
import confetti from 'canvas-confetti'
import './Stage.css'

type StageState = 'IDLE' | 'ROLLING' | 'REVEAL'

type StageStatus = {
  state: 'IDLE' | 'ROLLING' | 'REVEAL'
  backgroundUrl?: string
  bgmReadyUrl?: string
  bgmRollingUrl?: string
  bgmWinUrl?: string
  stageEffects?: StageEffects
  prizeId?: string
  drawRunId?: string
  prizeName?: string
  seed?: string
  candidateHash?: string
  winners?: Array<{ id: string; name: string; employeeId: string; department: string }>
}

type StagePrize = {
  id: string
  name: string
  level: number
  quantity: number
  drawnCount: number
  mediaUrl: string
  createdAt: string
}

type DrawResponse = {
  drawRun: { id: string }
  prize: { name: string }
  winners: Array<{ id: string; name: string; employeeId: string; department: string }>
}

type Participant = { id: string; name: string; department: string }

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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

function confettiColors(theme: StageEffects['theme']): string[] {
  if (theme === 'festive') return ['#FFD700', '#FF3B30', '#34C759', '#5AC8FA', '#AF52DE', '#FFFFFF']
  if (theme === 'simple') return ['#5AC8FA', '#D6ECFF', '#FFFFFF']
  return ['#FFD700', '#F0E68C', '#FFF3CF', '#FFFFFF']
}

function splitEventName(raw: string): { kicker: string; title: string } {
  const value = (raw ?? '').trim()
  if (!value) return { kicker: 'LOTTERY STAGE', title: '年会抽奖' }

  // Allow operators to control hierarchy by naming like:
  // "XX TECH GROUP｜2025年度总结大会暨颁奖典礼"
  for (const sep of ['｜', '|']) {
    const idx = value.indexOf(sep)
    if (idx > 0 && idx < value.length - 1) {
      const left = value.slice(0, idx).trim()
      const right = value.slice(idx + 1).trim()
      if (left && right) return { kicker: left, title: right }
    }
  }

  return { kicker: 'LOTTERY STAGE', title: value }
}

function useRollingName(active: boolean, pool: Participant[]) {
  const [current, setCurrent] = useState<Participant | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number>(0)

  useEffect(() => {
    if (!active || pool.length === 0) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastTickRef.current = 0
      return
    }

    const tick = (ts: number) => {
      const elapsed = ts - lastTickRef.current
      if (elapsed >= 40) {
        lastTickRef.current = ts
        const idx = Math.floor(Math.random() * pool.length)
        setCurrent(pool[idx] ?? null)
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [active, pool])

  return current
}

export function StagePage() {
  const params = useParams()
  const eventId = params.eventId ?? ''

  const controlMode = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get('control') === '1'
    } catch {
      return false
    }
  }, [])

  const [eventName, setEventName] = useState<string>('年会抽奖')
  const [backgroundUrl, setBackgroundUrl] = useState<string>('')
  const [bgmReadyUrl, setBgmReadyUrl] = useState<string>('')
  const [bgmRollingUrl, setBgmRollingUrl] = useState<string>('')
  const [bgmWinUrl, setBgmWinUrl] = useState<string>('')
  const [stageEffects, setStageEffects] = useState<StageEffects>(() => DEFAULT_STAGE_EFFECTS)
  const [state, setState] = useState<StageState>('IDLE')
  const [drawPrizeName, setDrawPrizeName] = useState<string>('')
  const [activePrizeId, setActivePrizeId] = useState<string>('')
  const [activeDrawRunId, setActiveDrawRunId] = useState<string>('')
  const [winners, setWinners] = useState<Winner[]>([])
  const [pool, setPool] = useState<Participant[]>([])
  const [prizes, setPrizes] = useState<StagePrize[]>([])
  const [selectedPrizeId, setSelectedPrizeId] = useState<string>('')
  const [drawLoading, setDrawLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [ready, setReady] = useState(false)

  const lastDrawRunIdRef = useRef<string>('')
  const initialStatusHandledRef = useRef(false)
  const rollingTokenRef = useRef(0)
  const manualActionRef = useRef(false)
  const stateRef = useRef<StageState>('IDLE')
  const confettiDrawRunIdRef = useRef<string>('')

  const { unlockAudio, sfxVolume, setSfxVolume } = useStageAudio(state, ready)
  const { unlockBgm, bgmVolume, setBgmVolume } = useStageBgm(state, ready, { ready: bgmReadyUrl, rolling: bgmRollingUrl, win: bgmWinUrl })

  const rollingName = useRollingName(state === 'ROLLING', pool)

  const header = useMemo(() => splitEventName(eventName), [eventName])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    initialStatusHandledRef.current = false
    lastDrawRunIdRef.current = ''
    rollingTokenRef.current += 1
  }, [eventId])

  const subtitle = useMemo(() => {
    if (state === 'IDLE') return controlMode ? '即将抽取…' : '等待抽奖开始…'
    if (state === 'ROLLING') return '正在抽取…'
    return '恭喜获奖！'
  }, [controlMode, state])

  const eventIdError = eventId ? '' : '缺少 eventId：请使用 /stage/:eventId 打开'

  const currentPrize = useMemo(() => prizes.find((p) => p.id === selectedPrizeId) ?? null, [prizes, selectedPrizeId])
  const displayPrize = useMemo(() => {
    if (state === 'IDLE' && controlMode) return currentPrize
    const id = activePrizeId || selectedPrizeId
    return prizes.find((p) => p.id === id) ?? currentPrize
  }, [activePrizeId, controlMode, currentPrize, prizes, selectedPrizeId, state])
  const prizeMediaUrl = displayPrize?.mediaUrl ? displayPrize.mediaUrl : ''
  const prizeMediaMode = displayPrize?.level === 1 ? 'prestige' : 'ambient'

  const loadPrizes = useCallback(async () => {
    if (!eventId) return

    const data = await apiJson<{ prizes: StagePrize[] }>(`/api/v1/events/${eventId}/prizes`)
    const sorted = [...data.prizes].sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level
      // If level wasn't configured, assume newer-created prizes are "smaller" and should be drawn earlier.
      return b.createdAt.localeCompare(a.createdAt)
    })

    setPrizes(sorted)
    if (controlMode) {
      setSelectedPrizeId((prev) => {
        const current = sorted.find((p) => p.id === prev)
        if (current && current.drawnCount < current.quantity) return prev

        const firstAvailable = sorted.find((p) => p.drawnCount < p.quantity)?.id ?? ''
        if (!prev) return firstAvailable

        const idx = sorted.findIndex((p) => p.id === prev)
        if (idx < 0) return firstAvailable

        // Prefer advancing towards "bigger prizes" (later in the sorted list), but never wrap.
        for (let i = idx + 1; i < sorted.length; i++) {
          const candidate = sorted[i]
          if (candidate && candidate.drawnCount < candidate.quantity) return candidate.id
        }
        for (let i = idx - 1; i >= 0; i--) {
          const candidate = sorted[i]
          if (candidate && candidate.drawnCount < candidate.quantity) return candidate.id
        }

        return ''
      })
    }
  }, [controlMode, eventId])

  const handleStartRolling = useCallback(async () => {
    if (!eventId || !controlMode) return
    if (drawLoading) return
    if (!selectedPrizeId) {
      // All prizes exhausted (or not loaded yet): keep the stage frame unchanged.
      setError('')
      return
    }
    if (!currentPrize || currentPrize.drawnCount >= currentPrize.quantity) {
      // Selected prize is not drawable: ignore instead of yelling on stage.
      setError('')
      return
    }

    setError('')
    setDrawLoading(true)
    manualActionRef.current = true

    try {
      const data = await apiJson<{ state: 'ROLLING'; prizeId: string; prizeName: string }>(`/api/v1/events/${eventId}/start-rolling`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prizeId: selectedPrizeId }),
      })

      setDrawPrizeName(data.prizeName || currentPrize?.name || '')
      setActivePrizeId(data.prizeId)
      setActiveDrawRunId('')
      setWinners([])
      setState('ROLLING')
    } catch (e) {
      setError(friendlyErrorMessage(e))
    } finally {
      manualActionRef.current = false
      setDrawLoading(false)
    }
  }, [controlMode, currentPrize, drawLoading, eventId, selectedPrizeId])

  const handleStopAndDraw = useCallback(async () => {
    if (!eventId || !controlMode) return
    if (drawLoading) return
    if (!selectedPrizeId) {
      setError('')
      return
    }

    setError('')
    setDrawLoading(true)
    manualActionRef.current = true

    try {
      const data = await apiJson<DrawResponse>(`/api/v1/events/${eventId}/draw`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prizeId: selectedPrizeId }),
      })

      lastDrawRunIdRef.current = data.drawRun.id
      setDrawPrizeName(data.prize.name)
      setActivePrizeId(selectedPrizeId)
      setActiveDrawRunId(data.drawRun.id)
      setWinners(data.winners.map((w) => ({ id: w.id, name: w.name, department: w.department })))
      setState('REVEAL')

      await loadPrizes()
    } catch (e) {
      setError(friendlyErrorMessage(e))
    } finally {
      manualActionRef.current = false
      setDrawLoading(false)
    }
  }, [controlMode, drawLoading, eventId, loadPrizes, selectedPrizeId])

  const handleNextRound = useCallback(async () => {
    if (!eventId || !controlMode) return
    if (drawLoading) return

    setError('')
    setDrawLoading(true)
    manualActionRef.current = true

    try {
      await apiJson(`/api/v1/events/${eventId}/stage/idle`, { method: 'POST' })
      setWinners([])
      setDrawPrizeName('')
      setActivePrizeId('')
      setActiveDrawRunId('')
      setState('IDLE')
      await loadPrizes()
    } catch (e) {
      setError(friendlyErrorMessage(e))
    } finally {
      manualActionRef.current = false
      setDrawLoading(false)
    }
  }, [controlMode, drawLoading, eventId, loadPrizes])

  const handleInteraction = useCallback(async () => {
    if (!controlMode) return
    const s = stateRef.current
    if (s === 'IDLE') {
      await handleStartRolling()
      return
    }
    if (s === 'ROLLING') {
      await handleStopAndDraw()
      return
    }
    await handleNextRound()
  }, [controlMode, handleNextRound, handleStartRolling, handleStopAndDraw])

  useEffect(() => {
    if (!controlMode || !ready) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      void handleInteraction()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [controlMode, handleInteraction, ready])

  const deptNoiseText = useMemo(() => {
    const depts = Array.from(new Set(pool.map((p) => p.department).filter(Boolean)))
    if (depts.length === 0) return ''

    const repeated: string[] = []
    for (let i = 0; i < 80; i++) repeated.push(depts[i % depts.length]!)
    return repeated.join(' · ')
  }, [pool])

  useEffect(() => {
    if (!eventId) return

    void (async () => {
      try {
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
        setError('')
      } catch (err) {
        setError(friendlyErrorMessage(err))
      }
    })()
  }, [eventId])

  useEffect(() => {
    if (!eventId) return

    let cancelled = false
    const run = async () => {
      try {
        await loadPrizes()
      } catch (e) {
        if (cancelled) return
        setError(friendlyErrorMessage(e))
      }
    }

    void run()
    const timer = setInterval(() => void run(), 30_000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [controlMode, eventId, loadPrizes])

  useEffect(() => {
    if (!eventId) return

    let stopped = false
    const load = async () => {
      try {
        const data = await apiJson<{ participants: Array<{ id: string; name: string; department: string }> }>(
          `/api/v1/events/${eventId}/participants/sample?limit=80`,
        )
        if (stopped) return
        setPool(data.participants.map((p) => ({ id: p.id, name: p.name, department: p.department })))
      } catch {
        // ignore: stage can still roll without a pool
      }
    }

    void load()
    const timer = setInterval(() => void load(), 60_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [eventId])

  useEffect(() => {
    if (!eventId) return

    let stopped = false
    const poll = async () => {
      try {
        const data = await apiJson<StageStatus>(`/api/v1/events/${eventId}/status`)
        if (stopped) return

        if (typeof data.backgroundUrl === 'string' && data.backgroundUrl !== backgroundUrl) {
          setBackgroundUrl(data.backgroundUrl)
        }
        if (typeof data.bgmReadyUrl === 'string' && data.bgmReadyUrl !== bgmReadyUrl) setBgmReadyUrl(data.bgmReadyUrl)
        if (typeof data.bgmRollingUrl === 'string' && data.bgmRollingUrl !== bgmRollingUrl) setBgmRollingUrl(data.bgmRollingUrl)
        if (typeof data.bgmWinUrl === 'string' && data.bgmWinUrl !== bgmWinUrl) setBgmWinUrl(data.bgmWinUrl)
        if (data.stageEffects) {
          const next = parseStageEffects(data.stageEffects)
          setStageEffects((prev) => {
            if (
              prev.confettiEnabled === next.confettiEnabled &&
              prev.confettiIntensity === next.confettiIntensity &&
              prev.theme === next.theme
            ) {
              return prev
            }
            return next
          })
        }

        if (manualActionRef.current) return

        if (data.state === 'IDLE') {
          initialStatusHandledRef.current = true
          setDrawPrizeName('')
          setWinners([])
          setActivePrizeId('')
          setActiveDrawRunId('')
          setState('IDLE')
          return
        }

        if (data.state === 'ROLLING') {
          initialStatusHandledRef.current = true
          setDrawPrizeName(data.prizeName ?? '')
          setWinners([])
          setActivePrizeId(data.prizeId ?? '')
          setActiveDrawRunId('')
          setState('ROLLING')
          return
        }

        // REVEAL
        if (!data.drawRunId) {
          initialStatusHandledRef.current = true
          setDrawPrizeName('')
          setWinners([])
          setActivePrizeId('')
          setActiveDrawRunId('')
          setState('IDLE')
          return
        }

        const nextWinners = (data.winners ?? []).map((w) => ({ id: w.id, name: w.name, department: w.department }))

        if (data.drawRunId === lastDrawRunIdRef.current) {
          // If we missed some transition, force the screen into the correct reveal frame.
          if (stateRef.current !== 'REVEAL' && nextWinners.length) {
            setDrawPrizeName(data.prizeName ?? '')
            setActivePrizeId(data.prizeId ?? '')
            setActiveDrawRunId(data.drawRunId)
            setWinners(nextWinners)
            setState('REVEAL')
          }
          initialStatusHandledRef.current = true
          return
        }

        const isInitialReveal = !initialStatusHandledRef.current && !lastDrawRunIdRef.current
        initialStatusHandledRef.current = true
        lastDrawRunIdRef.current = data.drawRunId
        setDrawPrizeName(data.prizeName ?? '')
        setActivePrizeId(data.prizeId ?? '')
        setActiveDrawRunId(data.drawRunId)

        // First load of an already-finished event: render without replay.
        if (isInitialReveal) {
          // Don't blast confetti/SFX on first open.
          confettiDrawRunIdRef.current = data.drawRunId
          setWinners(nextWinners)
          setState('REVEAL')
          return
        }

        // Host-controlled stop: rolling -> reveal should snap immediately.
        if (stateRef.current === 'ROLLING') {
          setWinners(nextWinners)
          setState('REVEAL')
          return
        }

        // Fallback: if someone drew without starting rolling, keep the old 3s suspense.
        const token = ++rollingTokenRef.current
        setWinners([])
        setState('ROLLING')

        await sleep(3000)
        if (stopped || token !== rollingTokenRef.current) return

        setWinners(nextWinners)
        setState('REVEAL')
        return
      } catch {
        // keep last frame: stage should not flicker on transient errors
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), 1000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [eventId, backgroundUrl, bgmReadyUrl, bgmRollingUrl, bgmWinUrl])

  const fireConfetti = useCallback(() => {
    try {
      const intensity = clampNumber(stageEffects.confettiIntensity, 0.5, 2.0)
      const colors = confettiColors(stageEffects.theme)
      const origin = { x: 0.5, y: 0.68 }
      confetti({ particleCount: Math.round(120 * intensity), spread: 70, startVelocity: 55, origin, colors })
      confetti({ particleCount: Math.round(80 * intensity), spread: 110, startVelocity: 42, origin, colors })
      confetti({ particleCount: Math.round(40 * intensity), spread: 140, startVelocity: 32, origin, colors })
    } catch {
      // ignore
    }
  }, [stageEffects.confettiIntensity, stageEffects.theme])

  useEffect(() => {
    if (state !== 'REVEAL') return
    if (!activeDrawRunId) return
    if (!winners.length) return
    if (!stageEffects.confettiEnabled) return

    if (confettiDrawRunIdRef.current === activeDrawRunId) return
    confettiDrawRunIdRef.current = activeDrawRunId

    if (!ready) return
    fireConfetti()
  }, [activeDrawRunId, fireConfetti, ready, stageEffects.confettiEnabled, state, winners.length])

  return (
    <div
      className="stage-root"
      onClick={(e) => {
        if (!controlMode || !ready) return
        const target = e.target as HTMLElement | null
        if (!target) return
        if (target.closest('button,select,a,input,textarea,label')) return
        if (target.closest('.stage-topbar')) return
        void handleInteraction()
      }}
    >
      <header className="stage-topbar" aria-label="舞台顶栏">
        <div className="stage-topbar-left">
          <div className="stage-topbar-kicker">{header.kicker}</div>
          <div className="stage-topbar-title" title={header.title}>
            {header.title}
          </div>
        </div>
      </header>

      {backgroundUrl ? (
        isMp4(backgroundUrl) ? (
          <video className="stage-bg stage-bg-video" src={backgroundUrl} autoPlay loop muted playsInline />
        ) : (
          <div className="stage-bg" style={{ backgroundImage: `url(${backgroundUrl})` }} />
        )
      ) : null}
      <div className="stage-shine" />
      {prizeMediaUrl ? (
        <div className={`stage-prize-media stage-prize-media--${prizeMediaMode}`} aria-hidden="true">
          {isMp4(prizeMediaUrl) ? (
            <video src={prizeMediaUrl} muted autoPlay loop playsInline className="stage-prize-media-inner" />
          ) : (
            <img src={prizeMediaUrl} className="stage-prize-media-inner" alt="" />
          )}
        </div>
      ) : null}
      {deptNoiseText ? (
        <>
          <div className="stage-noise stage-noise-a">{deptNoiseText}</div>
          <div className="stage-noise stage-noise-c">{deptNoiseText}</div>
          <div className="stage-noise stage-noise-b">{deptNoiseText}</div>
        </>
      ) : null}
      <div className="stage-center">
        {state !== 'IDLE' && drawPrizeName ? <div className="stage-prize">{drawPrizeName}</div> : null}
        <div style={{ opacity: 0.75 }}>{subtitle}</div>

        {eventIdError || error ? <div style={{ color: '#ffb0b0' }}>{eventIdError || error}</div> : null}

        {state === 'IDLE' ? (
          controlMode ? (
            <>
              <div className="stage-rolling">{currentPrize ? currentPrize.name : '所有奖项已抽完'}</div>
              {currentPrize ? (
                <div style={{ fontSize: 20, opacity: 0.7 }}>
                  共 {currentPrize.quantity} 名，已抽{' '}
                  <span style={{ color: '#ffe9b2', fontWeight: 800 }}>{currentPrize.drawnCount}</span> 名
                </div>
              ) : null}
            </>
          ) : (
            <div className="stage-rolling" style={{ opacity: 0.5 }}>
              READY
            </div>
          )
        ) : null}

        {state === 'ROLLING' ? (
          <div className="stage-rolling">
            {rollingName ? rollingName.name : '…'}
          </div>
        ) : null}

        {state === 'REVEAL' && winners.length ? (
          <WinnerReveal winners={winners} />
        ) : null}
      </div>

      {!controlMode ? <div className="stage-hint">提示：按 F11 全屏；舞台端 1 秒轮询</div> : null}

      {ready ? (
        <div className="stage-mix" aria-label="混音控制">
          <div className="stage-mix-badge">MIX</div>
          <div className="stage-mix-panel">
            <div className="stage-mix-row">
              <div className="stage-mix-label">BGM</div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(bgmVolume * 100)}
                onChange={(e) => setBgmVolume(Number(e.target.value) / 100)}
              />
            </div>
            <div className="stage-mix-row">
              <div className="stage-mix-label">SFX</div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(sfxVolume * 100)}
                onChange={(e) => setSfxVolume(Number(e.target.value) / 100)}
              />
            </div>
          </div>
        </div>
      ) : null}

      {controlMode && ready ? (
        <div className="absolute bottom-0 left-0 right-0 h-28 bg-gradient-to-t from-black via-black/90 to-transparent z-50 flex flex-col items-center justify-center gap-2 opacity-0 hover:opacity-100 transition-opacity duration-300 pb-4">
          <div className="flex items-center gap-6">
            <Link to="/admin" className="px-4 py-2 border border-slate-600 text-slate-300 rounded hover:text-white hover:border-white text-sm">
              ⚙ 设置
            </Link>

            {state === 'IDLE' ? (
              <>
                <select
                  value={selectedPrizeId}
                  onChange={(e) => setSelectedPrizeId(e.target.value)}
                  className="bg-slate-800 text-white border border-slate-600 rounded px-4 py-2 outline-none focus:border-yellow-500"
                >
                  {prizes.length === 0 ? <option value="">（暂无奖项）</option> : null}
                  {prizes.map((p) => (
                    <option key={p.id} value={p.id} disabled={p.drawnCount >= p.quantity}>
                      {p.name} ({p.drawnCount}/{p.quantity}) {p.drawnCount >= p.quantity ? '✅' : ''}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void handleStartRolling()}
                  disabled={drawLoading || !currentPrize || currentPrize.drawnCount >= currentPrize.quantity}
                  className="px-8 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white font-bold rounded-full shadow-lg transition-all flex items-center gap-2"
                >
                  {drawLoading ? '…' : '开始'}
                </button>
              </>
            ) : null}

            {state === 'ROLLING' ? (
              <>
                <div className="text-yellow-500 font-mono animate-pulse">正在抽奖中…（空格/点击停止）</div>
                <button
                  onClick={() => void handleStopAndDraw()}
                  disabled={drawLoading}
                  className="px-8 py-2 bg-red-600 hover:bg-red-500 disabled:bg-slate-700 text-white font-bold rounded-full shadow-lg transition-all"
                >
                  {drawLoading ? '…' : '停止'}
                </button>
              </>
            ) : null}

            {state === 'REVEAL' ? (
              <button onClick={() => void handleNextRound()} className="px-8 py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-full shadow-lg">
                继续下一轮 →
              </button>
            ) : null}
          </div>
          <div className="text-xs text-slate-500">鼠标移出底部区域自动隐藏控制栏</div>
        </div>
      ) : null}

      {!ready ? (
        <div
          className="stage-overlay"
          onClick={() => {
            unlockAudio()
            unlockBgm()
            setReady(true)
            void document.documentElement.requestFullscreen?.().catch(() => {})
          }}
        >
          <div className="stage-overlay-inner">
            <div className="stage-overlay-title">准备就绪</div>
            <div className="stage-overlay-sub">
              {controlMode ? '点击屏幕进入演示模式（鼠标移到底部可唤起控制栏）' : '点击任意处进入全屏舞台（解锁声音）'}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
