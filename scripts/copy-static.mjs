// Статика страницы настроек клиента: tsc копирует только .ts.
import { cpSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"

const from = "src/settings"
const to = "dist/settings"
mkdirSync(to, { recursive: true })
for (const name of readdirSync(from)) {
  if (!name.endsWith(".ts")) cpSync(join(from, name), join(to, name))
}
