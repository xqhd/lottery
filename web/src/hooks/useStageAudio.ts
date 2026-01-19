import { useCallback, useEffect, useRef, useState } from 'react'

export type StageAudioStatus = 'IDLE' | 'ROLLING' | 'REVEAL'

const ROLLING_BASE = 0.55
const WIN_BASE = 0.9
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

export function useStageAudio(status: StageAudioStatus, enabled: boolean) {
  const rollingAudioRef = useRef<HTMLAudioElement | null>(null)
  const winAudioRef = useRef<HTMLAudioElement | null>(null)
  const lastStatusRef = useRef<StageAudioStatus>('IDLE')
  const [unlocked, setUnlocked] = useState(false)
  const [sfxVolume, setSfxVolume] = useState<number>(() => readInitialVolume())

  useEffect(() => {
    const rolling = new Audio('/assets/rolling.mp3')
    rolling.preload = 'auto'
    rolling.loop = true
    rolling.volume = ROLLING_BASE

    const win = new Audio('/assets/win.mp3')
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
    if (unlocked) return
    const rolling = rollingAudioRef.current
    if (!rolling) {
      setUnlocked(true)
      return
    }

    const prevVolume = rolling.volume
    rolling.volume = 0

    rolling
      .play()
      .then(() => {
        rolling.pause()
        rolling.currentTime = 0
      })
      .catch(() => {
        // ignore (missing file / autoplay policies)
      })
      .finally(() => {
        rolling.volume = prevVolume
        setUnlocked(true)
      })
  }, [unlocked])

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
      void rolling.play().catch(() => {})
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
        void win.play().catch(() => {})
      }
      return
    }

    stopAll()
  }, [enabled, status, unlocked])

  return { unlockAudio, sfxVolume, setSfxVolume }
}
