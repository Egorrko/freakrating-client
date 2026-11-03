// API окна выбора экрана (локальная страница dist/picker/picker.html).
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld(
  "screenPicker",
  Object.freeze({
    sources: () => ipcRenderer.invoke("fc:picker:sources"),
    choose: (id: string | null) => ipcRenderer.send("fc:picker:choose", id),
  }),
)
