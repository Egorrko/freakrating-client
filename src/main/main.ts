// Точка входа: флаги графики, окно мира, падения, рация, Discord, IPC.
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron"
import { join } from "node:path"
import {
  CRASH_STREAK_RESET_MS,
  CRASH_STREAK_TO_SUGGEST,
  UNRESPONSIVE_RELOAD_MS,
  parseCli,
} from "./config"
import { applyGpuSwitches, preferDiscreteGpuOnWindows } from "./gpu"
import {
  BACKEND_LABELS,
  availableBackends,
  isBackend,
  loadSettings,
  nextBackend,
  updateSettings,
  type Settings,
} from "./settings"
import { NavigationPolicy, isExternalScheme, isWorldPath, safeUrl } from "./navigation"
import { collectDiagnostics, recordCrash, startCrashReporter, type CrashEvent } from "./diagnostics"
import { PushToTalk } from "./ptt"
import { DiscordPresence } from "./discord"
import { createTray } from "./tray"
import { WindowVisibility } from "./visibility"
import { EscapeGesture } from "./escape"

// ---------- до app.ready ----------

const cli = parseCli(process.argv, process.env)
const settings = loadSettings()
const gpu = applyGpuSwitches(settings, cli.backend)
startCrashReporter()

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// Twitch и прочие смотрят на User-Agent: «Electron/…» в нём выдаёт встроенный
// браузер. Оставляем обычный Chrome.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|freakrating-client|FreakRating)\/\S+/g, "")

const resumeUrl = process.argv.find((a) => a.startsWith("--resume-url="))?.slice("--resume-url=".length)
const policy = new NavigationPolicy(cli.url)
const startUrl = resumeUrl && policy.isAppUrl(resumeUrl) ? resumeUrl : cli.url

const ptt = new PushToTalk()
const discord = new DiscordPresence()

let win: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let quitting = false
let lastAppUrl = startUrl

// Падения: серия «подряд», сброс после спокойных минут.
let crashStreak = 0
let lastCrashAt = 0
let recovering = false
let pendingRecovery: (CrashEvent & { streak: number }) | null = null
let suggestedBackendThisSession = false
let unresponsiveTimer: NodeJS.Timeout | null = null
const visibility = new WindowVisibility()

// ---------- окно мира ----------

function createWindow(): BrowserWindow {
  const saved = settings.window
  const w = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: "#000000",
    title: "FreakRating",
    icon: join(__dirname, "../../assets/icon.png"),
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  })
  if (saved?.maximized) w.maximize()
  w.once("ready-to-show", () => w.show())

  guardContents(w.webContents)
  watchCrashes(w)
  watchVisibility(w)

  w.on("close", (e) => {
    saveWindowState(w)
    if (quitting) return
    if (!isWorldPath(w.webContents.getURL())) return
    const answer = dialog.showMessageBoxSync(w, {
      type: "question",
      buttons: ["Выйти", "Остаться"],
      defaultId: 1,
      cancelId: 1,
      title: "FreakRating",
      message: "Выйти из мира?",
    })
    if (answer !== 0) e.preventDefault()
    else quitting = true
  })
  w.on("closed", () => {
    win = null
  })

  const wc = w.webContents
  const escape = new EscapeGesture({
    grantGesture: () => wc.executeJavaScript("0", true),
    resend: (type, modifiers) => {
      if (!wc.isDestroyed()) wc.sendInputEvent({ type, keyCode: "Escape", modifiers })
    },
  })
  w.webContents.on("before-input-event", (event, input) => {
    // Esc — с активацией: страница вернёт захват мыши без клика (escape.ts).
    if (policy.isAppUrl(wc.getURL()) && escape.handle(input)) {
      event.preventDefault()
      return
    }
    if (input.type !== "keyDown") return
    // Ctrl+, — настройки клиента (меню нет, а трей есть не везде).
    if ((input.control || input.meta) && input.key === ",") {
      event.preventDefault()
      openSettingsWindow()
    }
    // F12 с Ctrl+Shift — инструменты разработчика (диагностика у игрока).
    if (input.control && input.shift && input.key === "F12") {
      event.preventDefault()
      w.webContents.toggleDevTools()
    }
  })

  void w.loadURL(startUrl)
  if (cli.devtools) w.webContents.openDevTools({ mode: "detach" })
  return w
}

/** Свернули, спрятали в трей, вернули — странице `onWindowVisibility`. */
function watchVisibility(w: BrowserWindow): void {
  const push = () => {
    if (w.isDestroyed()) return
    const hidden = visibility.update(w)
    if (hidden !== null) w.webContents.send("fc:windowVisibility", hidden)
  }
  w.on("minimize", push)
  w.on("restore", push)
  w.on("hide", push)
  w.on("show", push)
  // Перезагруженная страница начинает с «видно»: спрятанное окно ей напоминаем.
  w.webContents.on("did-finish-load", () => {
    if (visibility.current) w.webContents.send("fc:windowVisibility", true)
  })
}

function saveWindowState(w: BrowserWindow): void {
  if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return
  const maximized = w.isMaximized()
  const b = maximized ? (settings.window ?? w.getNormalBounds()) : w.getBounds()
  updateSettings({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } })
}

/** Навигация только по allowlist; ссылки наружу — в системный браузер. */
function guardContents(wc: WebContents): void {
  const onNavigate = (e: Electron.Event, url: string, isMainFrame = true) => {
    if (!isMainFrame) return
    const verdict = policy.decide(url)
    if (verdict === "allow") return
    e.preventDefault()
    if (verdict === "external") void shell.openExternal(url)
  }
  wc.on("will-navigate", (e) => onNavigate(e, e.url, e.isMainFrame))
  wc.on("will-redirect", (e) => onNavigate(e, e.url, e.isMainFrame))
  wc.setWindowOpenHandler(({ url }) => {
    const u = safeUrl(url)
    if (u && isExternalScheme(u)) void shell.openExternal(url)
    return { action: "deny" }
  })
  wc.on("will-attach-webview", (e) => e.preventDefault())

  const remember = (url: string) => {
    if (policy.isAppUrl(url)) lastAppUrl = url
  }
  wc.on("did-navigate", (_e, url) => remember(url))
  wc.on("did-navigate-in-page", (_e, url, isMainFrame) => isMainFrame && remember(url))
  wc.on("did-finish-load", () => {
    if (pendingRecovery) {
      wc.send("fc:crashRecovered", pendingRecovery)
      pendingRecovery = null
    }
  })
}

function setupPermissions(): void {
  const allowed = new Set([
    "media", // микрофон рации, веб-камера
    "pointerLock",
    "fullscreen",
    "keyboardLock",
    "clipboard-sanitized-write",
    "notifications",
    "speaker-selection",
  ])
  const fromApp = (url: string | undefined) => !!url && policy.isAppUrl(url)
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed.has(permission) && fromApp(details.requestingUrl ?? wc.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    return allowed.has(permission) && fromApp(origin)
  })
}

// ---------- падения ----------

function watchCrashes(w: BrowserWindow): void {
  const wc = w.webContents
  wc.on("render-process-gone", (_e, d) => {
    if (d.reason === "clean-exit") return
    recover({ kind: "renderer", reason: d.reason, exitCode: d.exitCode })
  })
  wc.on("unresponsive", () => {
    if (unresponsiveTimer) return
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null
      if (w.isDestroyed()) return
      recover({ kind: "unresponsive", reason: `не отвечает ${UNRESPONSIVE_RELOAD_MS / 1000} с` }, true)
    }, UNRESPONSIVE_RELOAD_MS)
  })
  wc.on("responsive", () => {
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer)
    unresponsiveTimer = null
  })
}

app.on("child-process-gone", (_e, d) => {
  if (d.type !== "GPU" || d.reason === "clean-exit") return
  recover({ kind: "gpu", reason: d.reason, exitCode: d.exitCode })
})

function recover(ev: Omit<CrashEvent, "at" | "url">, killRenderer = false): void {
  if (!win || win.isDestroyed()) return
  // GPU и страница часто падают парой — это одно падение.
  if (recovering) return
  recovering = true
  setTimeout(() => (recovering = false), 3_000)

  const now = Date.now()
  crashStreak = now - lastCrashAt > CRASH_STREAK_RESET_MS ? 1 : crashStreak + 1
  lastCrashAt = now
  const crash = recordCrash({ ...ev, url: lastAppUrl })
  pendingRecovery = { ...crash, streak: crashStreak }

  const wc = win.webContents
  if (killRenderer) wc.forcefullyCrashRenderer()
  // Сразу после падения GPU-процесс ещё поднимается — чуть подождём.
  setTimeout(() => {
    if (!win || win.isDestroyed()) return
    void win.webContents.loadURL(lastAppUrl)
    if (crashStreak >= CRASH_STREAK_TO_SUGGEST) void suggestOtherBackend()
  }, 1_000)
}

async function suggestOtherBackend(): Promise<void> {
  const next = nextBackend(gpu.backend)
  if (suggestedBackendThisSession || !win || !next) return
  suggestedBackendThisSession = true
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: [`Переключить на ${BACKEND_LABELS[next]} и перезапустить`, "Оставить как есть"],
    defaultId: 0,
    cancelId: 1,
    title: "FreakRating",
    message: `Мир падает уже ${crashStreak} раза подряд`,
    detail:
      `Сейчас графика: ${BACKEND_LABELS[gpu.backend]}. Часто помогает другой графический режим. ` +
      "Сменить его можно и потом: Ctrl+, или значок в трее → Настройки.",
  })
  if (response === 0) {
    applySettings({ graphicsBackend: next })
    relaunch()
  }
}

// ---------- настройки ----------

function publicSettings() {
  const s = loadSettings()
  return {
    graphicsBackend: s.graphicsBackend,
    /** Бэкенд, с которым клиент реально запущен (флаг запуска мог переопределить). */
    activeGraphicsBackend: gpu.backend,
    availableBackends: availableBackends().map((id) => ({ id, label: BACKEND_LABELS[id] })),
    restartRequired: s.graphicsBackend !== gpu.backend,
    preferDiscreteGpu: s.preferDiscreteGpu,
    ptt: ptt.status(),
    discord: { enabled: discord.enabled, connected: discord.status().connected },
  }
}

function applySettings(patch: Partial<Settings>): void {
  const before = loadSettings()
  const s = updateSettings(patch)
  if ("ptt" in patch) ptt.setBinding(s.ptt)
  if (patch.preferDiscreteGpu !== undefined && patch.preferDiscreteGpu !== before.preferDiscreteGpu) {
    preferDiscreteGpuOnWindows(s.preferDiscreteGpu)
  }
  const pub = publicSettings()
  for (const w of [win, settingsWin]) {
    if (w && !w.isDestroyed()) w.webContents.send("fc:settingsChanged", pub)
  }
  tray?.refresh()
}

function relaunch(): void {
  const args = process.argv
    .slice(1)
    .filter((a) => !a.startsWith("--resume-url=") && !a.startsWith("--graphics-backend="))
  args.push(`--resume-url=${lastAppUrl}`)
  quitting = true
  app.relaunch({ args })
  app.quit()
}

function openSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: true,
    minimizable: false,
    title: "Настройки клиента FreakRating",
    backgroundColor: "#1a0a1f",
    parent: win ?? undefined,
    icon: join(__dirname, "../../assets/icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/settings-preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  settingsWin.setMenu(null)
  settingsWin.webContents.on("will-navigate", (e) => e.preventDefault())
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  settingsWin.on("closed", () => (settingsWin = null))
  void settingsWin.loadFile(join(__dirname, "../settings/settings.html"))
}

// ---------- IPC ----------

function fromWorld(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!win && e.sender === win.webContents && !!e.senderFrame && policy.isAppUrl(e.senderFrame.url)
}
function fromSettings(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!settingsWin && e.sender === settingsWin.webContents
}
function fromEither(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return fromWorld(e) || fromSettings(e)
}

async function diagnostics() {
  return collectDiagnostics({
    graphics: { ...publicSettings(), switches: gpu.switches },
    crashStreak,
    discord: discord.status(),
    url: lastAppUrl,
  })
}

function setupIpc(): void {
  ipcMain.on("fc:info", (e) => {
    e.returnValue = { clientVersion: app.getVersion(), platform: process.platform }
  })
  ipcMain.on("fc:setPresence", (e, presence) => {
    if (fromWorld(e)) discord.set(presence)
  })
  ipcMain.handle("fc:getDiagnostics", (e) => (fromEither(e) ? diagnostics() : null))
  ipcMain.handle("fc:getSettings", (e) => (fromEither(e) ? publicSettings() : null))
  ipcMain.handle("fc:setGraphicsBackend", (e, backend) => {
    if (!fromEither(e) || !isBackend(backend)) return null
    applySettings({ graphicsBackend: backend })
    return publicSettings()
  })
  ipcMain.handle("fc:relaunch", (e) => {
    if (fromEither(e)) relaunch()
  })
  ipcMain.handle("fc:openSettings", (e) => {
    if (fromWorld(e)) openSettingsWindow()
  })

  // Только окно настроек.
  ipcMain.handle("fc:setPreferDiscreteGpu", (e, on) => {
    if (!fromSettings(e) || typeof on !== "boolean") return null
    applySettings({ preferDiscreteGpu: on })
    return publicSettings()
  })
  ipcMain.handle("fc:capturePtt", async (e) => {
    if (!fromSettings(e)) return null
    const binding = await ptt.captureNext()
    if (binding) applySettings({ ptt: binding })
    return publicSettings()
  })
  ipcMain.handle("fc:clearPtt", (e) => {
    if (!fromSettings(e)) return null
    applySettings({ ptt: null })
    return publicSettings()
  })
  ipcMain.handle("fc:copyDiagnostics", async (e) => {
    if (!fromSettings(e)) return false
    clipboard.writeText(JSON.stringify(await diagnostics(), null, 2))
    return true
  })
  ipcMain.handle("fc:openDumps", (e) => {
    if (fromSettings(e)) void shell.openPath(app.getPath("crashDumps"))
  })
}

// ---------- старт ----------

let tray: ReturnType<typeof createTray> | null = null

app.on("second-instance", () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.on("before-quit", () => {
  quitting = true
})

app.on("window-all-closed", () => {
  app.quit()
})

app.on("will-quit", () => {
  ptt.stop()
  discord.stop()
})

void app.whenReady().then(() => {
  // Меню нет: вместе с ним уходят Ctrl+R/F5 (перезагрузка), Ctrl+W (закрыть),
  // Ctrl+Shift+I и зум — их Electron вешает только на меню по умолчанию.
  Menu.setApplicationMenu(null)
  setupPermissions()
  setupIpc()
  if (settings.preferDiscreteGpu) preferDiscreteGpuOnWindows(true)

  ptt.start(settings.ptt)
  ptt.on("down", () => win?.webContents.send("fc:ptt", "down"))
  ptt.on("up", () => win?.webContents.send("fc:ptt", "up"))
  discord.start()

  win = createWindow()
  tray = createTray({
    show: () => {
      win?.show()
      win?.focus()
    },
    reload: () => void win?.webContents.loadURL(lastAppUrl),
    openSettings: openSettingsWindow,
    toggleDevTools: () => win?.webContents.toggleDevTools(),
    openDumps: () => void shell.openPath(app.getPath("crashDumps")),
    quit: () => {
      quitting = true
      app.quit()
    },
  })
})
