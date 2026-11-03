// Окно выбора экрана или окна для показа (main: screenShare.ts). Обычный скрипт без модулей (CSP: только 'self').
;(() => {
  type PickerSource = { id: string; name: string; kind: "screen" | "window"; thumbnail: string; icon: string | null }

  const picker = (window as unknown as {
    screenPicker: { sources(): Promise<PickerSource[] | null>; choose(id: string | null): void }
  }).screenPicker

  function card(source: PickerSource): HTMLButtonElement {
    const button = document.createElement("button")
    button.className = "card"
    button.title = source.name
    const thumb = document.createElement("img")
    thumb.className = "thumb"
    thumb.src = source.thumbnail
    thumb.alt = ""
    const name = document.createElement("div")
    name.className = "name"
    if (source.icon) {
      const icon = document.createElement("img")
      icon.src = source.icon
      icon.alt = ""
      name.append(icon)
    }
    const label = document.createElement("span")
    label.textContent = source.name
    name.append(label)
    button.append(thumb, name)
    button.addEventListener("click", () => picker.choose(source.id))
    return button
  }

  async function main(): Promise<void> {
    const sources = (await picker.sources()) ?? []
    const screens = sources.filter((s) => s.kind === "screen")
    const windows = sources.filter((s) => s.kind === "window")
    document.getElementById("screens")!.append(...screens.map(card))
    document.getElementById("windows")!.append(...windows.map(card))
    document.getElementById("screens-block")!.hidden = screens.length === 0
    document.getElementById("windows-block")!.hidden = windows.length === 0
    document.getElementById("empty")!.hidden = sources.length > 0
    document.querySelector<HTMLButtonElement>(".card")?.focus()
  }

  document.getElementById("cancel")!.addEventListener("click", () => picker.choose(null))
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") picker.choose(null)
  })
  void main()
})()
