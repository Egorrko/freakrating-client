// Страница настроек клиента. Обычный скрипт без модулей (CSP: только 'self').
;(() => {
  interface PublicSettings {
    graphicsBackend: string
    activeGraphicsBackend: string
    availableBackends: Array<{ id: string; label: string }>
    restartRequired: boolean
    preferDiscreteGpu: boolean
    ptt: {
      available: boolean
      mechanisms: string[]
      binding: { label: string } | null
      fifoPath: string | null
      error: string | null
    }
  }
  interface SettingsApi {
    get(): Promise<PublicSettings>
    setGraphicsBackend(b: string): Promise<PublicSettings>
    setPreferDiscreteGpu(on: boolean): Promise<PublicSettings>
    capturePtt(): Promise<PublicSettings>
    clearPtt(): Promise<PublicSettings>
    relaunch(): Promise<void>
    copyDiagnostics(): Promise<boolean>
    openDumps(): Promise<void>
    onChanged(cb: (s: PublicSettings) => void): void
  }
  const api = (window as unknown as { clientSettings: SettingsApi }).clientSettings
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

  function render(s: PublicSettings): void {
    const box = $("backends")
    box.replaceChildren(
      ...s.availableBackends.map(({ id, label }) => {
        const l = document.createElement("label")
        const r = document.createElement("input")
        r.type = "radio"
        r.name = "backend"
        r.value = id
        r.checked = id === s.graphicsBackend
        r.addEventListener("change", () => void api.setGraphicsBackend(id).then(render))
        const active = id === s.activeGraphicsBackend ? " — сейчас" : ""
        l.append(r, ` ${label}${active}`)
        return l
      }),
    )
    $<HTMLInputElement>("discrete").checked = s.preferDiscreteGpu
    $("restart").hidden = !s.restartRequired

    const p = s.ptt
    $("ptt-key").textContent = p.binding?.label ?? "не назначена"
    const canCapture = p.mechanisms.includes("uiohook")
    $<HTMLButtonElement>("ptt-set").disabled = !canCapture
    const note = $("ptt-note")
    note.replaceChildren()
    if (p.fifoPath && !canCapture) {
      // Wayland: глобальные клавиши задаёт композитор.
      $("ptt-key").textContent = "задаётся в настройках Hyprland/Sway"
      note.append(
        "На Wayland приложение не видит клавиши в фоне. Добавьте в ~/.config/hypr/hyprland.conf:",
        Object.assign(document.createElement("pre"), {
          textContent:
            `bind  = , F8, exec, timeout 1 sh -c 'echo down > ${p.fifoPath}'\n` +
            `bindr = , F8, exec, timeout 1 sh -c 'echo up > ${p.fifoPath}'`,
        }),
        "Когда окно мира в фокусе, рация работает и без этого — клавишей из настроек мира.",
      )
    } else if (!p.available) {
      note.textContent = `Рация в фоне недоступна: ${p.error ?? "нет способа слушать клавиши"}. В фокусе — клавиша из настроек мира.`
    } else {
      note.textContent = "Работает, даже когда окно мира свёрнуто. Левая и правая кнопки мыши не назначаются."
    }
  }

  $("discrete").addEventListener("change", (e) => {
    void api.setPreferDiscreteGpu((e.target as HTMLInputElement).checked).then(render)
  })
  $("relaunch").addEventListener("click", () => void api.relaunch())
  $("ptt-set").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("ptt-set")
    btn.disabled = true
    $("ptt-key").textContent = "нажмите клавишу или боковую кнопку мыши… (Esc — отмена)"
    render(await api.capturePtt())
  })
  $("ptt-clear").addEventListener("click", () => void api.clearPtt().then(render))
  $("diag-copy").addEventListener("click", async () => {
    $("diag-note").textContent = (await api.copyDiagnostics())
      ? "Скопировано — вставьте в отчёт «У меня лагает»."
      : "Не получилось."
  })
  $("dumps").addEventListener("click", () => void api.openDumps())

  api.onChanged(render)
  void api.get().then(render)
})()
