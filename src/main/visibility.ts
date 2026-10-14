// Видно ли окно мира. backgroundThrottling выключен, поэтому Page Visibility в
// свёрнутом окне врёт («visible»), а мир рисует кадры дальше. Клиент сам следит
// за minimize/hide/restore/show и говорит странице `onWindowVisibility`.

export interface WindowLike {
  isMinimized(): boolean
  isVisible(): boolean
}

/** Помнит последнее отправленное состояние: событие — только при смене. */
export class WindowVisibility {
  private hidden = false

  get current(): boolean {
    return this.hidden
  }

  /** Новое состояние окна; `null` — не поменялось. */
  update(w: WindowLike): boolean | null {
    const hidden = w.isMinimized() || !w.isVisible()
    if (hidden === this.hidden) return null
    this.hidden = hidden
    return hidden
  }
}
