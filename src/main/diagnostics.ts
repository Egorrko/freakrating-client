// Диагностика для «У меня лагает»: процессы, полный GPU-info, падения, дампы.
import { app, crashReporter } from "electron"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"

export interface CrashEvent {
  at: string
  kind: "renderer" | "gpu" | "unresponsive" | "other"
  reason: string
  exitCode?: number
  url?: string
}

const crashes: CrashEvent[] = []

export function recordCrash(e: Omit<CrashEvent, "at">): CrashEvent {
  const ev = { at: new Date().toISOString(), ...e }
  crashes.push(ev)
  if (crashes.length > 50) crashes.shift()
  return ev
}

export function crashHistory(): CrashEvent[] {
  return crashes.slice()
}

/** Дампы пишутся локально, никуда не отправляются. Вызывать до `app.ready`. */
export function startCrashReporter(): void {
  crashReporter.start({ uploadToServer: false, compress: true })
}

function dumpFiles(): Array<{ name: string; bytes: number; at: string }> {
  const out: Array<{ name: string; bytes: number; at: string }> = []
  const walk = (dir: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory() && depth < 2) walk(p, depth + 1)
        else if (name.endsWith(".dmp")) out.push({ name, bytes: st.size, at: st.mtime.toISOString() })
      } catch {}
    }
  }
  walk(app.getPath("crashDumps"), 0)
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20)
}

export async function collectDiagnostics(extra: Record<string, unknown>) {
  let gpuInfo: unknown = null
  try {
    gpuInfo = await app.getGPUInfo("complete")
  } catch (e) {
    gpuInfo = { error: (e as Error).message }
  }
  return {
    collectedAt: new Date().toISOString(),
    client: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      uptimeSec: Math.round(process.uptime()),
    },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      version: typeof os.version === "function" ? os.version() : undefined,
      cpu: os.cpus()[0]?.model,
      cpuCount: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / 2 ** 20),
      freeMemMb: Math.round(os.freemem() / 2 ** 20),
      session: process.env.XDG_SESSION_TYPE,
    },
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    gpuInfo,
    // CPU в процентах за интервал между вызовами, память в КБ — как отдаёт Electron.
    appMetrics: app.getAppMetrics(),
    crashes: crashHistory(),
    crashDumps: { dir: app.getPath("crashDumps"), files: dumpFiles() },
    ...extra,
  }
}
