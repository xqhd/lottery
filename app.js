/* eslint-disable no-console */

// pkg entrypoint (Windows single-exe).
//
// Dev mode:
// - web: 5173 (Vite)
// - server: 3000 (Express)
//
// Packaged mode:
// - one single Express process serves BOTH:
//   - UI (from ./web/dist)
//   - API (from ./server/dist)
// - so we default to port 5173 to match users' muscle memory: http://localhost:5173/admin

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

function isPackaged() {
  return typeof process.pkg !== 'undefined'
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function getDataRootDir() {
  // Allow overriding for portable deployments.
  if (process.env.LOTTERY_DATA_DIR && process.env.LOTTERY_DATA_DIR.trim()) {
    return process.env.LOTTERY_DATA_DIR.trim()
  }

  const appData = process.env.APPDATA || process.env.LOCALAPPDATA
  if (appData) return path.join(appData, 'lottery')

  return path.join(os.homedir(), '.lottery')
}

function openBrowser(url) {
  // Best-effort.
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref()
      return
    }
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
      return
    }
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // ignore
  }
}

async function main() {
  // ---- writable runtime dirs (DB, uploads) ----
  const dataRoot = getDataRootDir()
  const dataDir = path.join(dataRoot, 'data')
  const uploadsDir = path.join(dataRoot, 'uploads')
  ensureDir(dataDir)
  ensureDir(uploadsDir)

  // Important: server/dist/config.js resolves dbPath/uploadDir using process.cwd().
  // To keep it stable for an exe, we pass ABSOLUTE paths via env BEFORE importing server modules.
  process.env.DB_PATH = process.env.DB_PATH || path.join(dataDir, 'lottery.sqlite')
  process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || uploadsDir

  // Packaged = single server. Default to 5173 for familiarity.
  const defaultPort = isPackaged() ? '5173' : '3000'
  process.env.PORT = process.env.PORT || defaultPort

  // Packaged UI served on same origin; keep CORS aligned.
  if (!process.env.CORS_ORIGIN) {
    process.env.CORS_ORIGIN = `http://localhost:${process.env.PORT}`
  }

  // ---- load server dist (ESM) ----
  const serverDistDir = path.join(__dirname, 'server', 'dist')
  const configMod = await import(pathToFileURL(path.join(serverDistDir, 'config.js')).href)
  const dbMod = await import(pathToFileURL(path.join(serverDistDir, 'db.js')).href)
  const storeMod = await import(pathToFileURL(path.join(serverDistDir, 'store.js')).href)
  const appMod = await import(pathToFileURL(path.join(serverDistDir, 'app.js')).href)

  const { config } = configMod
  const db = dbMod.openDb(config.dbPath)
  dbMod.migrate(db)
  const store = storeMod.createStore(db)
  const app = appMod.createApp(store)

  // ---- serve built web UI when available ----
  const webDistDir = path.join(__dirname, 'web', 'dist')
  const indexHtml = path.join(webDistDir, 'index.html')
  const hasWeb = fs.existsSync(indexHtml)
  if (hasWeb) {
    // eslint-disable-next-line global-require
    const express = require('express')
    app.use(express.static(webDistDir))
    app.get('*', (req, res, next) => {
      // Don't hijack API/static uploads.
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next()
      res.sendFile(indexHtml)
    })
  } else {
    console.warn('[lottery] web/dist missing. Run `npm run build` before packaging.')
  }

  const server = app.listen(config.port, () => {
    const base = `http://localhost:${config.port}`
    console.log(`[lottery] server listening: ${base}`)
    console.log(`[lottery] data: ${dataRoot}`)
    console.log(`[lottery] db: ${config.dbPath}`)
    console.log(`[lottery] uploads: ${config.uploadDir}`)
    if (hasWeb) console.log(`[lottery] UI: ${base}/admin`)

    if (isPackaged() && hasWeb && process.env.LOTTERY_OPEN_BROWSER !== '0') {
      openBrowser(`${base}/admin`)
    }
  })

  function shutdown() {
    server.close(() => {
      db.close()
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[lottery] fatal:', err)
  process.exit(1)
})

