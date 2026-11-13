// «Записать замер»: след Chrome (contentTracing — кадры, процесс GPU, композитор)
// и счётчики Windows за те же секунды — что делала видеокарта и CPU, пока мир тормозил.
// Результат — папка с файлами; игрок отправляет её, разбор — у разработчиков.
import { app, contentTracing, powerMonitor } from "electron"
import { execFile } from "node:child_process"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

/** Сколько секунд пишем: хватает на десятки кадров даже при 10 к/с, файл — несколько МБ. */
export const PROFILE_SECONDS = 10

/**
 * Категории: задачи всех потоков (toplevel), кадры страницы (devtools.timeline),
 * процесс GPU и композитор (gpu, viz). Без cc, blink и benchmark — они втрое
 * раздувают файл, а для «кто держит кадр» не нужны; без стеков JS.
 */
const CATEGORIES = [
  "toplevel",
  "gpu",
  "viz",
  "v8.execute",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-gpu.service",
  "disabled-by-default-viz.gpu_composite_time",
]

/**
 * Счётчики Windows (typeperf, без прав администратора): загрузка 3D-движка видеокарты,
 * частота CPU от базовой (меньше 100 — сброс частоты, нагрев или питание), загрузка CPU,
 * свободная память, общая память видеокарты, температура зон ACPI (кельвины × 10).
 */
export const WINDOWS_COUNTERS = [
  "\\GPU Engine(*engtype_3D)\\Utilization Percentage",
  "\\GPU Adapter Memory(*)\\Shared Usage",
  "\\Processor Information(_Total)\\% Processor Performance",
  "\\Processor Information(_Total)\\% Processor Utility",
  "\\Memory\\Available MBytes",
  "\\Thermal Zone Information(*)\\Temperature",
]

export type CounterSeries = { counter: string; values: Array<number | null> }

/**
 * CSV typeperf → ряды по счётчикам. Экземпляры одного счётчика (движки GPU по процессам)
 * складываются по секунде: «загрузка 3D всеми процессами».
 * Первая строка — заголовки (`"(PDH-CSV 4.0) ..."`, `"\\HOST\GPU Engine(pid_1_..._engtype_3D)\Utilization Percentage"`).
 */
export function parseTypeperf(csv: string): CounterSeries[] {
  const rows = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map((line) => line.slice(1, -1).split('","'))
  if (rows.length < 2) return []
  const [header, ...data] = rows
  const keyOf = (column: string) => {
    const path = column.replace(/^\\\\[^\\]+/, "")
    const m = path.match(/^\\([^(\\]+)(?:\(([^)]*)\))?\\(.+)$/)
    if (!m) return path
    const [, object, instance, name] = m
    if (object === "GPU Engine") return `GPU Engine 3D\\${name}`
    if (object === "GPU Adapter Memory") return `GPU Adapter Memory\\${name}`
    return instance ? `${object}(${instance})\\${name}` : `${object}\\${name}`
  }
  const keys = header.slice(1).map(keyOf)
  const order = [...new Set(keys)]
  return order.map((counter) => ({
    counter,
    values: data.map((row) => {
      let sum: number | null = null
      keys.forEach((key, i) => {
        if (key !== counter) return
        const value = Number.parseFloat(row[i + 1])
        if (Number.isFinite(value)) sum = (sum ?? 0) + value
      })
      return sum === null ? null : Math.round(sum * 10) / 10
    }),
  }))
}

function windowsCounters(seconds: number): Promise<CounterSeries[] | { error: string }> {
  if (process.platform !== "win32") return Promise.resolve({ error: "не Windows" })
  return new Promise((resolve) => {
    execFile(
      "typeperf",
      [...WINDOWS_COUNTERS, "-si", "1", "-sc", String(seconds)],
      { windowsHide: true, timeout: (seconds + 20) * 1000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        const series = parseTypeperf(String(stdout ?? ""))
        resolve(series.length ? series : { error: error?.message ?? "typeperf ничего не вернул" })
      },
    )
  })
}

function powerScheme(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile("powercfg", ["/getactivescheme"], { windowsHide: true, timeout: 5000 }, (error, stdout) =>
      resolve(error ? null : String(stdout).trim()),
    )
  })
}

/** Процессы клиента раз в секунду: CPU и память GPU-процесса и вкладки во время замера. */
function sampleMetrics(seconds: number) {
  const samples: unknown[] = []
  const timer = setInterval(() => {
    samples.push({
      t: Date.now(),
      procs: app.getAppMetrics().map((m) => ({
        type: m.type,
        name: m.name,
        cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10,
        mb: Math.round(m.memory.workingSetSize / 1024),
      })),
    })
  }, 1000)
  return new Promise<unknown[]>((resolve) =>
    setTimeout(() => {
      clearInterval(timer)
      resolve(samples)
    }, seconds * 1000),
  )
}

/**
 * Записать замер в новую папку и вернуть её путь. `diagnostics` — то же, что
 * «Скопировать диагностику» (видеокарта, драйвер, флаги), — в `system.json`.
 */
export async function recordProfile(diagnostics: () => Promise<unknown>): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const dir = join(app.getPath("documents"), "FreakRating", `zamer-${stamp}`)
  mkdirSync(dir, { recursive: true })
  const startedAt = new Date().toISOString()
  await contentTracing.startRecording({
    included_categories: CATEGORIES,
    excluded_categories: ["*"],
  })
  const [counters, metrics, scheme] = await Promise.all([
    windowsCounters(PROFILE_SECONDS),
    sampleMetrics(PROFILE_SECONDS),
    powerScheme(),
  ])
  const raw = await contentTracing.stopRecording(join(dir, "trace.json"))
  writeFileSync(join(dir, "trace.json.gz"), gzipSync(readFileSync(raw)))
  unlinkSync(raw)
  writeFileSync(
    join(dir, "system.json"),
    JSON.stringify(
      {
        startedAt,
        seconds: PROFILE_SECONDS,
        onBattery: powerMonitor.isOnBatteryPower(),
        powerScheme: scheme,
        counters,
        metrics,
        diagnostics: await diagnostics(),
      },
      null,
      2,
    ),
  )
  return dir
}
