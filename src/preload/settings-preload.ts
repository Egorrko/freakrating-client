// API окна настроек клиента (локальная страница dist/settings/settings.html).
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld(
  "clientSettings",
  Object.freeze({
    get: () => ipcRenderer.invoke("fc:getSettings"),
    setGraphicsBackend: (b: string) => ipcRenderer.invoke("fc:setGraphicsBackend", b),
    setPreferDiscreteGpu: (on: boolean) => ipcRenderer.invoke("fc:setPreferDiscreteGpu", on),
    capturePtt: () => ipcRenderer.invoke("fc:capturePtt"),
    clearPtt: () => ipcRenderer.invoke("fc:clearPtt"),
    relaunch: () => ipcRenderer.invoke("fc:relaunch"),
    copyDiagnostics: () => ipcRenderer.invoke("fc:copyDiagnostics"),
    openDumps: () => ipcRenderer.invoke("fc:openDumps"),
    onChanged: (cb: (s: unknown) => void) => {
      ipcRenderer.on("fc:settingsChanged", (_e, s) => cb(s))
    },
  }),
)
