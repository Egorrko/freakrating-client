// Рация глобальной клавишей: нажатие и отпускание, даже когда окно не в фокусе.
//
// Electron `globalShortcut` сообщает только нажатие — для «держи и говори» мало.
// Поэтому:
//  - Windows и Linux/X11 — uiohook-napi (системный хук клавиатуры и мыши,
//    готовые N-API-сборки, пересобирать под Electron не нужно);
//  - Linux/Wayland — хуки не работают (Wayland не отдаёт чужие нажатия), там
//    рацию в фоне шлёт сам композитор: бинды Hyprland/Sway пишут `down`/`up`
//    в именованный канал `$XDG_RUNTIME_DIR/freakrating-ptt` (README, «Linux»).
//    Канал открыт на всех Linux, не только на Wayland.
import { EventEmitter } from "node:events"
import { execFileSync } from "node:child_process"
import { openSync, unlinkSync, constants as fsc, statSync } from "node:fs"
import { join } from "node:path"
import { Socket } from "node:net"
import type { PttBinding } from "./settings"

type Hook = typeof import("uiohook-napi")

export interface PttStatus {
  /** Есть ли хоть один способ слышать клавишу в фоне. */
  available: boolean
  /** uiohook — глобальный хук; fifo — канал для биндов композитора. */
  mechanisms: Array<"uiohook" | "fifo">
  binding: PttBinding | null
  fifoPath: string | null
  error: string | null
}

export function isWayland(env = process.env): boolean {
  return process.platform === "linux" && (env.XDG_SESSION_TYPE === "wayland" || !!env.WAYLAND_DISPLAY)
}

export class PushToTalk extends EventEmitter {
  private hook: Hook | null = null
  private hookStarted = false
  private binding: PttBinding | null = null
  private pressed = false
  private error: string | null = null
  private fifoPath: string | null = null
  private fifoSocket: Socket | null = null
  private capture: ((b: PttBinding | null) => void) | null = null

  start(binding: PttBinding | null): void {
    this.binding = binding
    if (!isWayland()) this.startHook()
    if (process.platform === "linux") this.startFifo()
  }

  setBinding(binding: PttBinding | null): void {
    if (this.pressed) this.set(false)
    this.binding = binding
  }

  status(): PttStatus {
    const mechanisms: PttStatus["mechanisms"] = []
    if (this.hookStarted) mechanisms.push("uiohook")
    if (this.fifoSocket) mechanisms.push("fifo")
    return {
      available: mechanisms.length > 0,
      mechanisms,
      binding: this.binding,
      fifoPath: this.fifoPath,
      error: this.error,
    }
  }

  /** Ждёт следующую клавишу или боковую кнопку мыши — для «Назначить». Esc — отмена. */
  captureNext(timeoutMs = 10_000): Promise<PttBinding | null> {
    if (!this.hookStarted) return Promise.resolve(null)
    this.capture?.(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), timeoutMs)
      const done = (b: PttBinding | null) => {
        clearTimeout(timer)
        this.capture = null
        resolve(b)
      }
      this.capture = done
    })
  }

  stop(): void {
    if (this.hookStarted) {
      try {
        this.hook?.uIOhook.stop()
      } catch {}
      this.hookStarted = false
    }
    this.fifoSocket?.destroy()
    this.fifoSocket = null
    if (this.fifoPath) {
      try {
        unlinkSync(this.fifoPath)
      } catch {}
    }
  }

  private set(down: boolean): void {
    if (down === this.pressed) return // автоповтор клавиши
    this.pressed = down
    this.emit(down ? "down" : "up")
  }

  private startHook(): void {
    try {
      // Нативный модуль: грузим лениво, чтобы его поломка не роняла клиент.
      this.hook = require("uiohook-napi") as Hook
    } catch (e) {
      this.error = `uiohook-napi не загрузился: ${(e as Error).message}`
      return
    }
    const { uIOhook, UiohookKey } = this.hook
    const keyNames = new Map<number, string>()
    for (const [name, code] of Object.entries(UiohookKey)) keyNames.set(code as number, name)

    uIOhook.on("keydown", (e) => {
      if (this.capture) {
        if (e.keycode === UiohookKey.Escape) return this.capture(null)
        return this.capture({ type: "key", keycode: e.keycode, label: keyNames.get(e.keycode) ?? `Key ${e.keycode}` })
      }
      if (this.binding?.type === "key" && this.binding.keycode === e.keycode) this.set(true)
    })
    uIOhook.on("keyup", (e) => {
      if (this.binding?.type === "key" && this.binding.keycode === e.keycode) this.set(false)
    })
    uIOhook.on("mousedown", (e) => {
      const button = Number(e.button)
      // 1 и 2 — левая и правая: ими играют, на рацию не назначаем.
      if (this.capture && button >= 3) return this.capture({ type: "mouse", button, label: mouseLabel(button) })
      if (this.binding?.type === "mouse" && this.binding.button === button) this.set(true)
    })
    uIOhook.on("mouseup", (e) => {
      if (this.binding?.type === "mouse" && this.binding.button === Number(e.button)) this.set(false)
    })
    try {
      uIOhook.start()
      this.hookStarted = true
    } catch (e) {
      this.error = `uiohook не запустился: ${(e as Error).message}`
    }
  }

  private startFifo(): void {
    const dir = process.env.XDG_RUNTIME_DIR
    if (!dir) return
    const path = join(dir, "freakrating-ptt")
    try {
      try {
        if (!statSync(path).isFIFO()) unlinkSync(path)
      } catch {}
      try {
        execFileSync("mkfifo", ["-m", "600", path])
      } catch {
        // уже есть (прошлый запуск упал) — переиспользуем
      }
      // O_RDWR: канал не закрывается, когда отключился очередной писатель;
      // net.Socket читает его без блокировки пула потоков.
      const fd = openSync(path, fsc.O_RDWR | fsc.O_NONBLOCK)
      const sock = new Socket({ fd, readable: true, writable: false })
      let buf = ""
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8")
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const cmd = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (cmd === "down") this.set(true)
          else if (cmd === "up") this.set(false)
        }
        if (buf.length > 256) buf = ""
      })
      sock.on("error", (e) => {
        this.error = `канал рации: ${e.message}`
      })
      this.fifoSocket = sock
      this.fifoPath = path
    } catch (e) {
      this.error = `канал рации не открылся: ${(e as Error).message}`
    }
  }
}

function mouseLabel(button: number): string {
  if (button === 3) return "Колёсико (кнопка мыши 3)"
  if (button === 4) return "Боковая кнопка мыши 4"
  if (button === 5) return "Боковая кнопка мыши 5"
  return `Кнопка мыши ${button}`
}
