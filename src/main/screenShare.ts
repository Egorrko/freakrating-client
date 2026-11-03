// Показ экрана (getDisplayMedia страницы мира): какой экран или окно, и звук.
//
// Electron сам getDisplayMedia не обслуживает — без обработчика он всегда
// отклоняет. Источник:
//  - Linux/Wayland — системное окно выбора (xdg-desktop-portal): getSources
//    вызывает его сам и отдаёт один выбранный источник;
//  - Windows, Linux/X11 — своё окно выбора (src/picker) с превью экранов и окон.
// Звук:
//  - Windows — звук системы без звука самого клиента (loopbackWithoutChrome,
//    исключение процесса в WASAPI): иначе в показ попадут голоса мира, эхо;
//  - Linux — Chromium звук системы без себя не умеет, страница берёт
//    виртуальный микрофон venmic (screenAudio.ts) через startScreenAudio;
//  - macOS — без звука.
import { BrowserWindow, desktopCapturer, ipcMain, session, type DesktopCapturerSource, type Streams } from "electron"
import { join } from "node:path"
import { isWayland } from "./ptt"

export type SourceMode = "portal" | "picker"

/** Как выбрать источник: системным окном портала или своим. */
export function sourceMode(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): SourceMode {
  return platform === "linux" && isWayland(env) ? "portal" : "picker"
}

/** Звук показа: где он берётся. */
export type ScreenAudioKind = "loopback" | "virtual-mic" | "none"

export function screenAudioKind(platform: NodeJS.Platform): ScreenAudioKind {
  if (platform === "win32") return "loopback"
  if (platform === "linux") return "virtual-mic"
  return "none"
}

/** Звук системы без звука своего процесса — id устройства Chromium. В типах Electron его нет. */
const LOOPBACK_WITHOUT_SELF = "loopbackWithoutChrome" as Streams["audio"]

/** Карточка источника для своего окна выбора. */
export type PickerSource = { id: string; name: string; kind: "screen" | "window"; thumbnail: string; icon: string | null }

/** Подпись экрана: Chromium зовёт их по-английски («Entire screen», «Screen 1»). */
export function screenName(index: number, count: number): string {
  return count > 1 ? `Экран ${index + 1}` : "Весь экран"
}

export function toPickerSources(sources: DesktopCapturerSource[], hide: ReadonlySet<string>): PickerSource[] {
  const screens = sources.filter((s) => s.id.startsWith("screen:"))
  return sources
    .filter((s) => !hide.has(s.id) && !s.thumbnail.isEmpty())
    .map((s) => ({
      id: s.id,
      name: screens.includes(s) ? screenName(screens.indexOf(s), screens.length) : s.name,
      kind: s.id.startsWith("screen:") ? "screen" : "window",
      thumbnail: s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }))
}

type Options = {
  isAppOrigin: (origin: string) => boolean
  /** Окно мира: родитель окна выбора, его самого в списке нет. */
  parent: () => BrowserWindow | null
}

export function setupScreenShare(opts: Options): void {
  const mode = sourceMode(process.platform, process.env)
  const audioKind = screenAudioKind(process.platform)
  let picking = false

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!request.videoRequested || !opts.isAppOrigin(request.securityOrigin) || picking) return callback(null)
      picking = true
      const choose = mode === "portal" ? fromPortal() : fromPicker(opts.parent())
      choose
        .then((source) => {
          if (!source) return callback(null)
          const streams: Streams = { video: source }
          if (request.audioRequested && audioKind === "loopback") streams.audio = LOOPBACK_WITHOUT_SELF
          callback(streams)
        })
        .catch((err) => {
          console.error("[screenShare]", err)
          callback(null)
        })
        .finally(() => (picking = false))
    },
    // macOS 15+: системное окно выбора вместо нашего.
    { useSystemPicker: true },
  )
}

async function fromPortal(): Promise<DesktopCapturerSource | null> {
  const [source] = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
  return source ?? null
}

async function fromPicker(parent: BrowserWindow | null): Promise<DesktopCapturerSource | null> {
  const thumbs = { thumbnailSize: { width: 384, height: 216 }, fetchWindowIcons: true }
  let sources = await desktopCapturer.getSources({ types: ["screen", "window"], ...thumbs })
  // X11: перечисление окон иногда падает, и Electron отдаёт пустой список целиком — тогда хотя бы экраны.
  if (sources.length === 0) sources = await desktopCapturer.getSources({ types: ["screen"], ...thumbs })
  if (sources.length === 0) return null
  const hide = new Set<string>()
  if (parent && !parent.isDestroyed()) hide.add(parent.getMediaSourceId())
  const cards = toPickerSources(sources, hide)
  const id = await showPicker(parent, cards)
  return sources.find((s) => s.id === id) ?? null
}

function showPicker(parent: BrowserWindow | null, cards: PickerSource[]): Promise<string | null> {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 860,
      height: 600,
      minWidth: 480,
      minHeight: 360,
      title: "Что показать",
      backgroundColor: "#1a0a1f",
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: !!parent && process.platform !== "linux",
      minimizable: false,
      icon: join(__dirname, "../../assets/icon.png"),
      webPreferences: {
        preload: join(__dirname, "../preload/picker-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    })
    w.setMenu(null)
    w.webContents.on("will-navigate", (e) => e.preventDefault())
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }))

    let done = false
    const finish = (id: string | null) => {
      if (done) return
      done = true
      ipcMain.removeHandler("fc:picker:sources")
      ipcMain.removeAllListeners("fc:picker:choose")
      resolve(id)
      if (!w.isDestroyed()) w.close()
    }
    ipcMain.handle("fc:picker:sources", (e) => (e.sender === w.webContents ? cards : null))
    ipcMain.on("fc:picker:choose", (e, id: unknown) => {
      if (e.sender !== w.webContents) return
      finish(typeof id === "string" && cards.some((c) => c.id === id) ? id : null)
    })
    w.on("closed", () => finish(null))
    void w.loadFile(join(__dirname, "../picker/picker.html"))
  })
}
