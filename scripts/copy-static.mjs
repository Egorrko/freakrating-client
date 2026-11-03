// Статика локальных страниц клиента (настройки, выбор экрана): tsc копирует только .ts.
import { cpSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"

for (const page of ["settings", "picker"]) {
  const from = join("src", page)
  const to = join("dist", page)
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    if (!name.endsWith(".ts")) cpSync(join(from, name), join(to, name))
  }
}
