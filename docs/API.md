# `window.freakClient` — API клиента для страницы мира

Клиент отдаёт странице узкое API через preload (`src/preload/preload.ts`).
Есть только в окне клиента и только на своих адресах (`freakrating.lol`,
поддомены, дев-адрес из `--url=`). В обычном браузере `window.freakClient`
нет — сайт проверяет так:

```ts
const fc = window.freakClient
if (fc && fc.apiVersion >= 1) { /* мы в клиенте */ }
```

## Версия

| Поле | Тип | Что |
|---|---|---|
| `apiVersion` | `number` | Версия контракта, сейчас `1`. Несовместимые изменения поднимают её; новые методы добавляются без подъёма — проверяйте `typeof fc.метод === "function"`. |
| `clientVersion` | `string` | Версия клиента (`package.json`), например `"0.1.0"`. |
| `platform` | `"win32" \| "linux" \| "darwin"` | ОС. |

## События

Все подписки возвращают функцию отписки. Ошибка в колбэке не ломает клиент
(пишется в консоль страницы).

### `onPtt(cb: (state: "down" | "up") => void): () => void`

Рация глобальной клавишей: `"down"` — нажали, `"up"` — отпустили. Приходит и
когда окно в фокусе, и в фоне. Автоповтор клавиши отфильтрован: `down` и `up`
строго чередуются.

Клавишу выбирает игрок в настройках клиента (по умолчанию F8), это не клавиша
рации мира (V). Когда окно в фокусе, страница видит и свою клавишу — сайту
стоит считать рацию нажатой, если нажата любая из двух.

Источник — системный хук (Windows, Linux/X11) или бинды композитора (Linux/
Wayland, см. README). Есть ли он вообще — `getSettings().ptt.available`.

### `onCrashRecovered(cb: (info: CrashRecovered) => void): () => void`

Клиент перезагрузил мир после падения: GPU-процесс, процесс страницы или
страница не отвечала 10 с. Мир открывается на том же адресе, что был до
падения. Если событие пришло до подписки — колбэк вызовется сразу при
подписке (один раз за загрузку страницы).

```ts
interface CrashRecovered {
  at: string            // ISO-время падения
  kind: "renderer" | "gpu" | "unresponsive"
  reason: string        // reason из Electron: "crashed", "killed", "oom", "launch-failed"…
  exitCode?: number
  url?: string          // адрес, на который вернули
  streak: number        // падений подряд (сбрасывается после 5 минут без падений)
}
```

После двух падений подряд клиент сам предлагает другой графический режим
(диалог клиента) — сайту делать это не нужно, но можно показать своё.

### `onSettingsChanged(cb: (settings: ClientSettings) => void): () => void`

Игрок поменял что-то в окне настроек клиента. Формат — как у `getSettings()`.

### `onWindowVisibility(cb: (hidden: boolean) => void): () => void`

Окно свернули или спрятали в трей (`true`) и вернули (`false`). Фоновый
троттлинг в клиенте выключен, поэтому Page Visibility в свёрнутом окне врёт:
`document.hidden` остаётся `false`, `requestAnimationFrame` идёт ~60 раз в
секунду, и мир рисует кадры в никуда. По этому событию страница перестаёт
рисовать; голос, рация и сеть работают дальше.

Приходит только при смене. Если окно уже спрятано к моменту подписки (или
страница перезагрузилась в спрятанном окне) — колбэк сразу получит `true`.
Появилось после 0.1.1 без подъёма `apiVersion`: проверяйте
`typeof fc.onWindowVisibility === "function"`.

## Методы

### `setPresence(presence: Presence | null): void`

Статус в Discord. `null` — убрать. Если в клиенте не задан Discord client id
или Discord не запущен — молча ничего. Строки обрезаются до 128 символов,
неизвестные поля отбрасываются. Discord ограничивает частоту обновлений (~1 раз
в 15 с) — слать при смене состояния, не каждый кадр.

```ts
interface Presence {
  details?: string          // верхняя строка: "Во дворе"
  state?: string            // нижняя: "Монополия · 3 из 4"
  startTimestamp?: number   // мс Unix: таймер «прошло»
  partySize?: number
  partyMax?: number
  largeImageText?: string   // подсказка у картинки (по умолчанию "FreakRating")
  buttonLabel?: string      // кнопка в карточке, ≤32 символа
  buttonUrl?: string        // только https://freakrating.lol/…
}
```

### `getDiagnostics(): Promise<Diagnostics>`

Всё для отчёта «У меня лагает». Большой объект (десятки КБ из-за `gpuInfo`),
поля:

| Поле | Что |
|---|---|
| `collectedAt` | ISO-время |
| `client` | `{ version, packaged, uptimeSec }` |
| `versions` | `{ electron, chrome, node, v8 }` |
| `os` | `{ platform, arch, release, version, cpu, cpuCount, totalMemMb, freeMemMb, session }` |
| `gpuFeatureStatus` | `app.getGPUFeatureStatus()`: `webgl`, `gpu_compositing`, … → `"enabled"`, `"disabled_software"`… |
| `gpuInfo` | `app.getGPUInfo("complete")`: `gpuDevice[]` (vendorId, deviceId, driverVersion, active), `auxAttributes` (glRenderer, glVersion, …) |
| `appMetrics` | `app.getAppMetrics()`: процессы (`Browser`, `GPU`, `Tab`, `Utility`) с `cpu.percentCPUUsage` и `memory.workingSetSize` (КБ). CPU считается от прошлого вызова. |
| `crashes` | последние падения за сессию (как `CrashRecovered` без `streak`) |
| `crashDumps` | `{ dir, files: [{ name, bytes, at }] }` — локальные дампы, никуда не отправляются |
| `graphics` | `getSettings()` + `switches` — флаги Chromium, с которыми запущен клиент |
| `crashStreak` | падений подряд сейчас |
| `discord` | `{ enabled, connected, presence }` |
| `url` | текущий адрес мира |

### `getSettings(): Promise<ClientSettings>`

```ts
interface ClientSettings {
  graphicsBackend: "auto" | "d3d11" | "vulkan" | "gl"   // сохранённый
  activeGraphicsBackend: string    // с которым клиент запущен сейчас
  availableBackends: Array<{ id: string; label: string }>  // что есть на этой ОС
  restartRequired: boolean         // сохранённый ≠ активный
  preferDiscreteGpu: boolean
  ptt: {
    available: boolean             // слышим ли клавишу в фоне
    mechanisms: Array<"uiohook" | "fifo">
    binding: { type: "key" | "mouse"; label: string } | null
    fifoPath: string | null        // Linux: канал для биндов композитора
    error: string | null
  }
  discord: { enabled: boolean; connected: boolean }
}
```

### `setGraphicsBackend(backend: string): Promise<ClientSettings | null>`

Сохранить графический бэкенд. Применится после `relaunch()`. Неизвестный или
недоступный на этой ОС — `null`, ничего не меняется.

### `relaunch(): Promise<void>`

Перезапустить клиент. Мир откроется на текущем адресе. Спрашивать игрока —
дело страницы.

### `openSettings(): Promise<void>`

Открыть окно настроек клиента (то же, что Ctrl+, или трей → «Настройки»).

## Что клиент делает сам, без API

- Звук без клика (autoplay), без фонового троттлинга таймеров и рендера.
- Микрофон, камера, pointer lock, полный экран, Keyboard Lock — разрешены своим
  адресам без вопросов.
- Ctrl+R, F5, Ctrl+W, Ctrl+T, зум — не действуют (у окна нет меню). Сами
  клавиши до страницы доходят.
- Закрытие окна на `/world…` — с подтверждением.
- Ссылки на чужие сайты и `target=_blank` — в системный браузер.
