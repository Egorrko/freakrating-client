// window.freakClient — узкое API клиента для страницы мира. Контракт: docs/API.md.
// Preload работает в sandbox: только `electron`, никаких своих модулей.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"

const API_VERSION = 1

type Unsubscribe = () => void

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  if (typeof cb !== "function") throw new TypeError("callback must be a function")
  const listener = (_e: IpcRendererEvent, payload: T) => {
    try {
      cb(payload)
    } catch (err) {
      console.error("[freakClient]", channel, err)
    }
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// Событие о восстановлении приходит на did-finish-load — страница могла ещё не
// подписаться. Запоминаем и отдаём при подписке.
let lastRecovery: unknown = null
ipcRenderer.on("fc:crashRecovered", (_e, payload) => {
  lastRecovery = payload
})

function onCrashRecovered(cb: (info: unknown) => void): Unsubscribe {
  const unsubscribe = subscribe("fc:crashRecovered", cb)
  if (lastRecovery) {
    const payload = lastRecovery
    queueMicrotask(() => cb(payload))
  }
  return unsubscribe
}

const info = ipcRenderer.sendSync("fc:info") as { clientVersion: string; platform: string }

const api = {
  apiVersion: API_VERSION,
  clientVersion: info.clientVersion,
  platform: info.platform,

  /** Рация глобальной клавишей: "down" — нажали, "up" — отпустили. */
  onPtt: (cb: (state: "down" | "up") => void): Unsubscribe => subscribe("fc:ptt", cb),

  /** Мир перезагружен после падения GPU/страницы. */
  onCrashRecovered,

  /** Настройки клиента поменялись (игрок что-то переключил в окне настроек). */
  onSettingsChanged: (cb: (settings: unknown) => void): Unsubscribe => subscribe("fc:settingsChanged", cb),

  /** Статус в Discord; null — убрать. */
  setPresence: (presence: unknown): void => ipcRenderer.send("fc:setPresence", presence ?? null),

  getDiagnostics: (): Promise<unknown> => ipcRenderer.invoke("fc:getDiagnostics"),

  getSettings: (): Promise<unknown> => ipcRenderer.invoke("fc:getSettings"),

  /** Сохранить графический бэкенд; применится после relaunch(). */
  setGraphicsBackend: (backend: string): Promise<unknown> => ipcRenderer.invoke("fc:setGraphicsBackend", backend),

  /** Перезапустить клиент (после смены бэкенда). Вернёт мир на тот же адрес. */
  relaunch: (): Promise<void> => ipcRenderer.invoke("fc:relaunch"),

  /** Открыть окно настроек клиента. */
  openSettings: (): Promise<void> => ipcRenderer.invoke("fc:openSettings"),
}

contextBridge.exposeInMainWorld("freakClient", Object.freeze(api))
