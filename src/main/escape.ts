// Esc — жест пользователя (#321). Chromium не считает Esc пользовательской
// активацией, поэтому после Esc страница не может снова захватить мышь
// (`requestPointerLock` → NotAllowedError) — только кликом. Клиент придерживает
// каждое Esc-событие, даёт странице активацию (`executeJavaScript(…, true)`) и
// отдаёт событие заново доверенным вводом (`sendInputEvent`): обработчики
// страницы видят обычный keydown/keyup, но уже с активацией.
//
// Esc при захваченной мыши сюда не доходит: Chromium снимает захват раньше
// before-input-event и keydown съедает. Доходит только keyup — он тоже даёт
// активацию, и страница может вернуть захват после паузы самого Chromium (~1,25 с).
// Захват, взятый при нажатом Esc, Chromium снимет на отпускании — страница
// просит его на keyup (docs/API.md, «Esc и захват мыши»).

export interface EscInput {
  type: string
  key: string
  isAutoRepeat?: boolean
  shift?: boolean
  control?: boolean
  alt?: boolean
  meta?: boolean
}

export type EscModifier = "shift" | "control" | "alt" | "meta" | "isautorepeat"

export interface EscTarget {
  /** Дать странице пользовательскую активацию; промис — когда она уже есть. */
  grantGesture(): Promise<unknown>
  /** Отдать событие странице доверенным вводом. Вызывает before-input-event синхронно. */
  resend(type: "keyDown" | "keyUp", modifiers: EscModifier[]): void
}

/** Не дождались активации (страница висит, уходит) — событие всё равно отдаём. */
export const GRANT_TIMEOUT_MS = 500

export class EscapeGesture {
  private own = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly target: EscTarget,
    private readonly timeoutMs = GRANT_TIMEOUT_MS,
  ) {}

  /** `true` — событие придержано: вызывающий делает `preventDefault()`, отдадим сами. */
  handle(input: EscInput): boolean {
    if (input.key !== "Escape" || this.own) return false
    if (input.type !== "keyDown" && input.type !== "keyUp") return false
    const type = input.type
    const modifiers = modifiersOf(input)
    const grant = !input.isAutoRepeat
    // По очереди: keyup не обгоняет придержанный keydown.
    this.queue = this.queue.then(async () => {
      if (grant) await this.grant()
      this.own = true
      try {
        this.target.resend(type, modifiers)
      } catch {
        // окно закрылось — отдавать некому
      } finally {
        this.own = false
      }
    })
    return true
  }

  /** Все придержанные события отданы (для тестов). */
  idle(): Promise<void> {
    return this.queue
  }

  private async grant(): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.timeoutMs)
    })
    try {
      await Promise.race([this.target.grantGesture().catch(() => {}), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}

function modifiersOf(input: EscInput): EscModifier[] {
  const out: EscModifier[] = []
  if (input.shift) out.push("shift")
  if (input.control) out.push("control")
  if (input.alt) out.push("alt")
  if (input.meta) out.push("meta")
  if (input.isAutoRepeat) out.push("isautorepeat")
  return out
}
