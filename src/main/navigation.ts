// Куда окну можно ходить. Чистые функции — их проверяют тесты (test/navigation.test.mjs).
import { APP_HOSTS, OAUTH_FLOW_HOSTS, OAUTH_START_HOSTS } from "./config"

function hostMatches(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith("." + h))
}

export class NavigationPolicy {
  private readonly extraOrigins: Set<string>
  /** Идёт вход через Twitch: страницы twitch.tv пускаем в окно до возврата на сайт. */
  private oauthFlow = false

  constructor(startUrl: string) {
    this.extraOrigins = new Set()
    const u = safeUrl(startUrl)
    // Дев-адрес (`--url=http://localhost:4000/world`) — тоже «свой».
    if (u && !hostMatches(u.hostname, APP_HOSTS)) this.extraOrigins.add(u.origin)
  }

  isAppUrl(url: string): boolean {
    const u = safeUrl(url)
    if (!u) return false
    if (this.extraOrigins.has(u.origin)) return true
    return u.protocol === "https:" && hostMatches(u.hostname, APP_HOSTS)
  }

  /** Решение для перехода главного фрейма: пустить в окне или отдать системе. */
  decide(url: string): "allow" | "external" | "deny" {
    const u = safeUrl(url)
    if (!u) return "deny"
    if (this.isAppUrl(url)) {
      this.oauthFlow = false
      return "allow"
    }
    if (u.protocol === "https:" && hostMatches(u.hostname, OAUTH_START_HOSTS)) {
      this.oauthFlow = true
      return "allow"
    }
    if (this.oauthFlow && u.protocol === "https:" && hostMatches(u.hostname, OAUTH_FLOW_HOSTS)) {
      return "allow"
    }
    return isExternalScheme(u) ? "external" : "deny"
  }
}

/** Что можно отдать системе: браузер, почта, Telegram, Discord. */
export function isExternalScheme(u: URL): boolean {
  return ["https:", "http:", "mailto:", "tg:", "discord:"].includes(u.protocol)
}

export function safeUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** Путь мира — его закрытие подтверждаем и на него возвращаемся после падения. */
export function isWorldPath(url: string): boolean {
  const u = safeUrl(url)
  return !!u && (u.pathname === "/world" || u.pathname.startsWith("/world/"))
}
