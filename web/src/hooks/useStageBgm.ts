import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type StageBgmStatus = 'IDLE' | 'ROLLING' | 'REVEAL'

export type StageBgmUrls = {
  ready?: string
  rolling?: string
  win?: string
}

type Slot = 'ready' | 'rolling' | 'win'

const FADE_MS = 650
const STORAGE_KEY = 'lottery_vol_bgm'
const LEGACY_MASTER_KEY = 'stage_master_volume'

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function normalizeUrl(value: string | undefined): string {
  const v = (value ?? '').trim()
  return v
}

function readInitialVolume(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const legacy = localStorage.getItem(LEGACY_MASTER_KEY)
    const num = raw ? Number(raw) : legacy ? Number(legacy) : NaN
    if (!Number.isFinite(num)) return 0.5
    return clamp01(num)
  } catch {
    return 0.5
  }
}

export function useStageBgm(status: StageBgmStatus, enabled: boolean, urls: StageBgmUrls) {
  const audiosRef = useRef<Record<Slot, HTMLAudioElement | null>>({ ready: null, rolling: null, win: null })
  const unlockedRef = useRef(false)
  const [unlocked, setUnlocked] = useState(false)
  const [bgmVolume, setBgmVolume] = useState<number>(() => readInitialVolume())

  const target = useMemo(() => {
    const normalized: Record<Slot, string> = {
      ready: normalizeUrl(urls.ready),
      rolling: normalizeUrl(urls.rolling),
      win: normalizeUrl(urls.win),
    }

    const prefer: Slot[] =
      status === 'ROLLING'
        ? ['rolling', 'ready', 'win']
        : status === 'REVEAL'
          ? ['win', 'rolling', 'ready']
          : ['ready', 'rolling', 'win']

    const slot = prefer.find((s) => Boolean(normalized[s])) ?? 'ready'
    return { slot, url: normalized[slot], all: normalized }
  }, [status, urls.ready, urls.rolling, urls.win])

  const fadeRafRef = useRef<number | null>(null)

  const stopFade = () => {
    if (fadeRafRef.current) cancelAnimationFrame(fadeRafRef.current)
    fadeRafRef.current = null
  }

  const stopAll = useCallback(() => {
    stopFade()
    const audios = audiosRef.current
    for (const slot of Object.keys(audios) as Slot[]) {
      const a = audios[slot]
      if (!a) continue
      try {
        a.pause()
        a.currentTime = 0
        a.volume = 0
      } catch {
        // ignore
      }
    }
  }, [])

  const ensureAudio = useCallback((slot: Slot, url: string) => {
    const current = audiosRef.current[slot]
    if (current && current.src && current.src.endsWith(url)) return current

    if (current) {
      try {
        current.pause()
      } catch {
        // ignore
      }
    }

    const a = new Audio(url)
    a.preload = 'auto'
    a.loop = true
    a.volume = 0
    a.load()
    audiosRef.current[slot] = a
    return a
  }, [])

  // Keep audio objects in sync with URLs.
  useEffect(() => {
    const all = target.all
    for (const slot of Object.keys(all) as Slot[]) {
      const url = all[slot]
      if (!url) {
        const a = audiosRef.current[slot]
        if (a) {
          try {
            a.pause()
            a.currentTime = 0
            a.volume = 0
          } catch {
            // ignore
          }
        }
        audiosRef.current[slot] = null
        continue
      }
      ensureAudio(slot, url)
    }

    return () => {
      stopAll()
    }
  }, [ensureAudio, stopAll, target.all])

  const fadeTo = useCallback(
    (slot: Slot, url: string) => {
      const v = clamp01(bgmVolume)
      const audios = audiosRef.current
      const target = ensureAudio(slot, url)

      const startTs = performance.now()
      const starts: Record<Slot, number> = {
        ready: audios.ready?.volume ?? 0,
        rolling: audios.rolling?.volume ?? 0,
        win: audios.win?.volume ?? 0,
      }
      const ends: Record<Slot, number> = { ready: 0, rolling: 0, win: 0 }
      ends[slot] = v

      // Start the next track quietly, then fade up.
      void target.play().catch(() => {})

      stopFade()
      const tick = (ts: number) => {
        const t = Math.min(1, (ts - startTs) / FADE_MS)
        const k = t * (2 - t) // easeOutQuad
        for (const s of Object.keys(audios) as Slot[]) {
          const a = audios[s]
          if (!a) continue
          const from = starts[s] ?? 0
          const to = ends[s] ?? 0
          a.volume = from + (to - from) * k
        }
        if (t < 1) {
          fadeRafRef.current = requestAnimationFrame(tick)
          return
        }

        // Stop tracks that fully faded out.
        for (const s of Object.keys(audios) as Slot[]) {
          const a = audios[s]
          if (!a) continue
          if ((ends[s] ?? 0) <= 0.0001) {
            try {
              a.pause()
              a.currentTime = 0
            } catch {
              // ignore
            }
          }
        }

        fadeRafRef.current = null
      }

      fadeRafRef.current = requestAnimationFrame(tick)
    },
    [bgmVolume, ensureAudio],
  )

  const unlockBgm = useCallback(() => {
    if (unlockedRef.current) return
    unlockedRef.current = true

    const { slot, url, all } = target
    const fallback = url || all.ready || all.rolling || all.win
    const fallbackSlot: Slot = url
      ? slot
      : all.ready
        ? 'ready'
        : all.rolling
          ? 'rolling'
          : 'win'
    if (!fallback) {
      setUnlocked(true)
      return
    }

    const a = ensureAudio(fallbackSlot, fallback)
    const prev = a.volume
    a.volume = 0
    a.play()
      .then(() => {
        a.pause()
        a.currentTime = 0
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        a.volume = prev
        setUnlocked(true)
      })
  }, [ensureAudio, target])

  useEffect(() => {
    if (!enabled || !unlocked) {
      stopAll()
      return
    }

    if (!target.url) {
      stopAll()
      return
    }

    fadeTo(target.slot, target.url)
  }, [enabled, fadeTo, stopAll, target, unlocked])

  // When master volume changes, adjust instantly (without re-triggering fade transitions).
  useEffect(() => {
    if (!enabled || !unlocked) return
    const v = clamp01(bgmVolume)
    const audios = audiosRef.current
    for (const slot of Object.keys(audios) as Slot[]) {
      const a = audios[slot]
      if (!a) continue
      // Only scale the currently audible one(s).
      if (a.volume > 0.001) a.volume = v
    }
  }, [bgmVolume, enabled, unlocked])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(bgmVolume))
    } catch {
      // ignore
    }
  }, [bgmVolume])

  return { unlockBgm, bgmVolume, setBgmVolume }
}
