// Настройки клиента: JSON в userData, без сторонних библиотек.
import { app } from "electron"
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

export type GraphicsBackend = "auto" | "d3d11" | "vulkan" | "gl"

export type PttBinding =
  | { type: "key"; keycode: number; label: string }
  | { type: "mouse"; button: number; label: string }

export interface Settings {
  graphicsBackend: GraphicsBackend
  preferDiscreteGpu: boolean
  ptt: PttBinding | null
  window?: { x?: number; y?: number; width: number; height: number; maximized: boolean }
}

/** F8: не печатается, в мире не занята, есть на любой клавиатуре. */
export const DEFAULT_PTT: PttBinding = { type: "key", keycode: 66, label: "F8" }

export const BACKEND_LABELS: Record<GraphicsBackend, string> = {
  auto: "Авто",
  d3d11: "Direct3D 11",
  vulkan: "Vulkan",
  gl: "OpenGL",
}

/** Бэкенды ANGLE, которые есть смысл предлагать на этой ОС. */
export function availableBackends(platform = process.platform, env = process.env): GraphicsBackend[] {
  if (platform === "win32") return ["auto", "d3d11", "vulkan", "gl"]
  // На Wayland Chromium с Vulkan не работает («not compatible with Vulkan»).
  if (platform === "linux" && (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY)) return ["auto", "gl"]
  return ["auto", "gl", "vulkan"]
}

export function isBackend(value: unknown, platform = process.platform): value is GraphicsBackend {
  return typeof value === "string" && (availableBackends(platform, {}) as string[]).includes(value)
}

/** Следующий бэкенд по кругу — его предлагаем после падений подряд. */
/** null — предложить нечего (на Wayland есть только OpenGL). */
export function nextBackend(
  current: GraphicsBackend,
  platform = process.platform,
  env = process.env,
): GraphicsBackend | null {
  // «Авто» — это D3D11 на Windows и OpenGL на Linux: после него — следующий за ним.
  const order = availableBackends(platform, env).filter((b) => b !== "auto")
  if (order.length < 2) return null
  const effective = current === "auto" ? order[0] : current
  return order[(order.indexOf(effective) + 1) % order.length]
}

const DEFAULTS: Settings = {
  graphicsBackend: "auto",
  preferDiscreteGpu: true,
  ptt: DEFAULT_PTT,
}

function file(): string {
  return join(app.getPath("userData"), "settings.json")
}

export function sanitize(raw: unknown): Settings {
  const s = { ...DEFAULTS }
  if (!raw || typeof raw !== "object") return s
  const r = raw as Record<string, unknown>
  if (isBackend(r.graphicsBackend)) s.graphicsBackend = r.graphicsBackend
  if (typeof r.preferDiscreteGpu === "boolean") s.preferDiscreteGpu = r.preferDiscreteGpu
  if (r.ptt === null) s.ptt = null
  else if (isBinding(r.ptt)) s.ptt = r.ptt
  if (r.window && typeof r.window === "object") s.window = r.window as Settings["window"]
  return s
}

function isBinding(v: unknown): v is PttBinding {
  if (!v || typeof v !== "object") return false
  const b = v as Record<string, unknown>
  if (typeof b.label !== "string") return false
  if (b.type === "key") return Number.isInteger(b.keycode)
  if (b.type === "mouse") return Number.isInteger(b.button) && (b.button as number) >= 3
  return false
}

let current: Settings | null = null

export function loadSettings(): Settings {
  if (current) return current
  try {
    current = sanitize(JSON.parse(readFileSync(file(), "utf8")))
  } catch {
    current = { ...DEFAULTS }
  }
  return current
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = sanitize({ ...loadSettings(), ...patch })
  const path = file()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path + ".tmp", JSON.stringify(current, null, 2))
  renameSync(path + ".tmp", path)
  return current
}
