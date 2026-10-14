// Значок в трее: настройки и служебное, раз меню у окна нет.
import { Menu, Tray, nativeImage } from "electron"
import { join } from "node:path"

export interface TrayActions {
  show(): void
  reload(): void
  openSettings(): void
  toggleDevTools(): void
  openDumps(): void
  quit(): void
}

export function createTray(actions: TrayActions) {
  let tray: Tray | null = null
  try {
    tray = new Tray(nativeImage.createFromPath(join(__dirname, "../../assets/tray.png")))
  } catch {
    // Нет трея (часть Linux-окружений) — настройки остаются по Ctrl+,.
    return { refresh() {} }
  }
  tray.setToolTip("FreakRating")
  const build = () =>
    Menu.buildFromTemplate([
      { label: "Открыть мир", click: actions.show },
      { label: "Перезагрузить мир", click: actions.reload },
      { type: "separator" },
      { label: "Настройки клиента…  (Ctrl+,)", click: actions.openSettings },
      {
        label: "Диагностика",
        submenu: [
          { label: "Папка с дампами падений", click: actions.openDumps },
          { label: "Инструменты разработчика  (Ctrl+Shift+F12)", click: actions.toggleDevTools },
        ],
      },
      { type: "separator" },
      { label: "Выход", click: actions.quit },
    ])
  tray.setContextMenu(build())
  tray.on("click", actions.show)
  return {
    refresh() {
      tray?.setContextMenu(build())
    },
  }
}
