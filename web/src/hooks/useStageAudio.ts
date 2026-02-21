import { useCallback, useEffect, useRef, useState } from 'react'

export type StageAudioStatus = 'IDLE' | 'ROLLING' | 'REVEAL'

const ROLLING_BASE = 0.55
const WIN_BASE = 0.9
const PLAY_RETRY_DELAY_MS = 260
const PLAY_RETRY_ATTEMPTS = 2
const ROLLING_URL = '/assets/rolling.mp3'
const WIN_URL = '/assets/win.mp3'
const STORAGE_KEY = 'lottery_vol_sfx'
const LEGACY_MASTER_KEY = 'stage_master_volume'

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function readInitialVolume(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const legacy = localStorage.getItem(LEGACY_MASTER_KEY)
    const num = raw ? Number(raw) : legacy ? Number(legacy) : NaN
    if (!Number.isFinite(num)) return 1
    return clamp01(num)
  } catch {
    return 1
  }
}

function parsePlayError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message }
  if (error && typeof error === 'object') {
    const rec = error as { name?: unknown; message?: unknown }
    const name = typeof rec.name === 'string' ? rec.name : 'UnknownError'
    const message = typeof rec.message === 'string' ? rec.message : String(error)
    return { name, message }
  }
  return { name: 'UnknownError', message: String(error) }
}

function waitForCanPlayOrTimeout(audio: HTMLAudioElement, timeoutMs = PLAY_RETRY_DELAY_MS): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      audio.removeEventListener('canplay', onCanPlay)
      audio.removeEventListener('canplaythrough', onCanPlay)
      window.clearTimeout(timer)
      resolve()
    }
    const onCanPlay = () => finish()
    const timer = window.setTimeout(() => finish(), timeoutMs)
    audio.addEventListener('canplay', onCanPlay)
    audio.addEventListener('canplaythrough', onCanPlay)
    try {
      if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) audio.load()
    } catch {
      // ignore
    }
  })
}

async function playWithRetry(
  audio: HTMLAudioElement,
  slot: 'rolling' | 'win',
  state: StageAudioStatus,
): Promise<boolean> {
  for (let attempt = 1; attempt <= PLAY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await audio.play()
      return true
    } catch (error) {
      const info = parsePlayError(error)
      console.warn('[stage-audio] play failed', {
        channel: 'SFX',
        slot,
        state,
        attempt,
        name: info.name,
        message: info.message,
      })
      if (attempt >= PLAY_RETRY_ATTEMPTS) return false
      await waitForCanPlayOrTimeout(audio)
    }
  }
  return false
}

async function warmTrack(url: string, slot: 'rolling' | 'win', state: StageAudioStatus): Promise<void> {
  const audio = new Audio(url)
  audio.preload = 'auto'
  audio.loop = false
  audio.volume = 0

  try {
    audio.load()
    const ok = await playWithRetry(audio, slot, state)
    if (!ok) return
    audio.pause()
    audio.currentTime = 0
  } catch {
    // ignore
  }
}

export function useStageAudio(status: StageAudioStatus, enabled: boolean) {
  const rollingAudioRef = useRef<HTMLAudioElement | null>(null)
  const winAudioRef = useRef<HTMLAudioElement | null>(null)
  const lastStatusRef = useRef<StageAudioStatus>('IDLE')
  const unlockedRef = useRef(false)
  const [unlocked, setUnlocked] = useState(false)
  const [sfxVolume, setSfxVolume] = useState<number>(() => readInitialVolume())

  useEffect(() => {
    const rolling = new Audio(ROLLING_URL)
    rolling.preload = 'auto'
    rolling.loop = true
    rolling.volume = ROLLING_BASE

    const win = new Audio(WIN_URL)
    win.preload = 'auto'
    win.loop = false
    win.volume = WIN_BASE

    rolling.load()
    win.load()

    rollingAudioRef.current = rolling
    winAudioRef.current = win

    return () => {
      try {
        rolling.pause()
        rolling.currentTime = 0
      } catch {
        // ignore
      }

      try {
        win.pause()
        win.currentTime = 0
      } catch {
        // ignore
      }
    }
  }, [])

  useEffect(() => {
    const v = clamp01(sfxVolume)
    const rolling = rollingAudioRef.current
    const win = winAudioRef.current
    if (rolling) rolling.volume = v * ROLLING_BASE
    if (win) win.volume = v * WIN_BASE
  }, [sfxVolume])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(sfxVolume))
    } catch {
      // ignore
    }
  }, [sfxVolume])

  const unlockAudio = useCallback(() => {
    if (unlockedRef.current) return
    unlockedRef.current = true
    setUnlocked(true)
    void Promise.allSettled([
      warmTrack(ROLLING_URL, 'rolling', status),
      warmTrack(WIN_URL, 'win', status),
    ])
  }, [status])

  useEffect(() => {
    const prevStatus = lastStatusRef.current
    lastStatusRef.current = status

    if (!enabled || !unlocked) return

    const rolling = rollingAudioRef.current
    const win = winAudioRef.current
    if (!rolling || !win) return

    const stopAll = () => {
      try {
        rolling.pause()
        rolling.currentTime = 0
      } catch {
        // ignore
      }
      try {
        win.pause()
        win.currentTime = 0
      } catch {
        // ignore
      }
    }

    if (status === 'ROLLING') {
      stopAll()
      void playWithRetry(rolling, 'rolling', status)
      return
    }

    if (status === 'REVEAL') {
      try {
        rolling.pause()
        rolling.currentTime = 0
      } catch {
        // ignore
      }
      // Don't blast the "win" sound when audio just got unlocked on an already-revealed screen.
      if (prevStatus !== 'REVEAL') {
        win.currentTime = 0
        void playWithRetry(win, 'win', status)
      }
      return
    }

    stopAll()
  }, [enabled, status, unlocked])

  return { unlockAudio, sfxVolume, setSfxVolume }
}
