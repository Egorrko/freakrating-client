// Дымовая проверка: клиент против дев-сервера, вход через /dev/login, скриншот окна.
//   node scripts/smoke.mjs [--base=http://localhost:4000] [--as=ник] [--out=smoke.png]
import { _electron as electron } from "playwright-core"

const arg = (name, def) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? def
const base = arg("base", "http://localhost:4000")
const nick = arg("as", "smoke_client")
const out = arg("out", "smoke.png")

const app = await electron.launch({ args: [".", `--url=${base}/world`], env: { ...process.env } })
const win = await app.firstWindow()
win.on("console", (m) => m.type() === "error" && console.log("console:", m.text().slice(0, 200)))
await win.waitForLoadState("domcontentloaded")
await win.goto(`${base}/dev/login/${encodeURIComponent(nick)}?to=world`)
await win.waitForURL(/\/world/, { timeout: 30_000 })
await win.waitForTimeout(8_000)

const api = await win.evaluate(async () => {
  const fc = window.freakClient
  if (!fc) return null
  const d = await fc.getDiagnostics()
  return {
    apiVersion: fc.apiVersion,
    clientVersion: fc.clientVersion,
    methods: Object.keys(fc),
    settings: await fc.getSettings(),
    gpu: d.gpuFeatureStatus,
    processes: d.appMetrics.map((m) => m.type),
    gpuDevices: d.gpuInfo?.gpuDevice?.length,
  }
})
console.log("url:", win.url())
console.log("freakClient:", JSON.stringify(api, null, 1))
await win.screenshot({ path: out })
console.log("скриншот:", out)
await app.evaluate(({ app }) => app.exit(0))
