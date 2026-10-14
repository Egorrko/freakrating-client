// Статус в Discord (Rich Presence). Без client id или без запущенного Discord —
// молча ничего не делаем. Что показывать, решает страница (`setPresence`).
import { DISCORD_CLIENT_ID, DISCORD_LARGE_IMAGE } from "./config"

export interface Presence {
  details?: string
  state?: string
  /** Unix-время в мс: «в мире 12:34». */
  startTimestamp?: number
  partySize?: number
  partyMax?: number
  largeImageText?: string
  /** Кнопка-ссылка в карточке Discord (только freakrating.lol). */
  buttonLabel?: string
  buttonUrl?: string
}

const RETRY_MS = 30_000

type RpcClient = import("@xhayper/discord-rpc").Client

export class DiscordPresence {
  private client: RpcClient | null = null
  private ready = false
  private presence: Presence | null = null
  private retry: NodeJS.Timeout | null = null
  private readonly clientId: string

  constructor(clientId = process.env.FREAK_DISCORD_CLIENT_ID || DISCORD_CLIENT_ID) {
    this.clientId = clientId
  }

  get enabled(): boolean {
    return /^\d{5,}$/.test(this.clientId)
  }

  status() {
    return { enabled: this.enabled, connected: this.ready, presence: this.presence }
  }

  start(): void {
    if (!this.enabled) return
    void this.connect()
  }

  set(presence: Presence | null): void {
    this.presence = presence ? sanitizePresence(presence) : null
    void this.push()
  }

  stop(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const c = this.client
    this.client = null
    this.ready = false
    void c?.destroy().catch(() => {})
  }

  private async connect(): Promise<void> {
    try {
      const { Client } = await import("@xhayper/discord-rpc")
      const client = new Client({ clientId: this.clientId })
      client.on("disconnected", () => {
        this.ready = false
        this.schedule()
      })
      await client.login()
      this.client = client
      this.ready = true
      await this.push()
    } catch {
      // Discord не запущен — попробуем позже.
      this.ready = false
      this.schedule()
    }
  }

  private schedule(): void {
    if (this.retry || !this.enabled) return
    this.retry = setTimeout(() => {
      this.retry = null
      void this.connect()
    }, RETRY_MS)
  }

  private async push(): Promise<void> {
    if (!this.ready || !this.client?.user) return
    try {
      if (!this.presence) return void (await this.client.user.clearActivity())
      const p = this.presence
      await this.client.user.setActivity({
        details: p.details,
        state: p.state,
        startTimestamp: p.startTimestamp,
        partySize: p.partySize,
        partyMax: p.partyMax,
        largeImageKey: DISCORD_LARGE_IMAGE,
        largeImageText: p.largeImageText ?? "FreakRating",
        buttons: p.buttonLabel && p.buttonUrl ? [{ label: p.buttonLabel, url: p.buttonUrl }] : undefined,
        instance: false,
      })
    } catch {
      // Discord ответил ошибкой (например, лимит частоты) — следующий setPresence исправит.
    }
  }
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined
const int = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined

/** Страница — недоверенный источник: только известные поля, строки урезаны. */
export function sanitizePresence(raw: unknown): Presence | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const p: Presence = {
    details: str(r.details, 128),
    state: str(r.state, 128),
    startTimestamp: int(r.startTimestamp),
    partySize: int(r.partySize),
    partyMax: int(r.partyMax),
    largeImageText: str(r.largeImageText, 128),
  }
  const url = str(r.buttonUrl, 512)
  if (url && /^https:\/\/([a-z0-9-]+\.)*freakrating\.lol(\/|$)/i.test(url)) {
    p.buttonUrl = url
    p.buttonLabel = str(r.buttonLabel, 32) ?? "FreakRating"
  }
  // Discord не принимает строки короче двух символов.
  if (p.state?.length === 1) p.state += " "
  if (p.details?.length === 1) p.details += " "
  return p
}
