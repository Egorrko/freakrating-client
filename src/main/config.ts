// Константы клиента и разбор флагов запуска.

/** Адрес мира по умолчанию. Переопределяется `--url=` или `FREAK_URL`. */
export const DEFAULT_URL = "https://freakrating.lol/world"

/**
 * Discord Application ID для статуса в Discord (Rich Presence).
 * Пусто — статус молча выключен. Переопределяется `FREAK_DISCORD_CLIENT_ID`.
 * Завести: https://discord.com/developers/applications → New Application → Application ID.
 */
export const DISCORD_CLIENT_ID = ""

/** Ключ картинки в Rich Presence (Art Assets приложения Discord). */
export const DISCORD_LARGE_IMAGE = "logo"

/**
 * Хосты, по которым окно ходит само (главный фрейм). Всё остальное — в системный
 * браузер. Поддомены разрешены: `api.freakrating.lol` и т. п.
 */
export const APP_HOSTS = ["freakrating.lol", "freakland.egorrko.ru"]

/**
 * Вход через Twitch OAuth: сначала `id.twitch.tv/oauth2/authorize`, оттуда —
 * страницы логина twitch.tv. Пускаем их в окно только внутри такого входа
 * (см. `navigation.ts`), иначе обычные ссылки на каналы открылись бы в клиенте.
 */
export const OAUTH_START_HOSTS = ["id.twitch.tv"]
export const OAUTH_FLOW_HOSTS = ["twitch.tv", "id.twitch.tv", "passport.twitch.tv", "www.twitch.tv"]

/** Сколько падений подряд — и предлагаем другой графический режим. */
export const CRASH_STREAK_TO_SUGGEST = 2
/** Столько мс без падений — и счётчик «подряд» обнуляется. */
export const CRASH_STREAK_RESET_MS = 5 * 60_000
/** Столько мс страница может не отвечать, прежде чем перезагрузим мир. */
export const UNRESPONSIVE_RELOAD_MS = 10_000

export interface Cli {
  url: string
  backend?: string
  devtools: boolean
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv): Cli {
  const flag = (name: string): string | undefined => {
    const prefix = `--${name}=`
    const hit = argv.find((a) => a.startsWith(prefix))
    return hit?.slice(prefix.length)
  }
  return {
    url: flag("url") ?? env.FREAK_URL ?? DEFAULT_URL,
    backend: flag("graphics-backend") ?? env.FREAK_GRAPHICS_BACKEND,
    devtools: argv.includes("--devtools"),
  }
}
