// Чистая логика без Electron: node --test test/ (после npm run build).
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { NavigationPolicy, isWorldPath } = require("../dist/main/navigation.js")
const { nextBackend, sanitize, availableBackends } = require("../dist/main/settings.js")
const { sanitizePresence } = require("../dist/main/discord.js")
const { parseCli } = require("../dist/main/config.js")
const { WindowVisibility } = require("../dist/main/visibility.js")

test("свои адреса — в окне, чужие — в системный браузер", () => {
  const p = new NavigationPolicy("https://freakrating.lol/world")
  assert.equal(p.decide("https://freakrating.lol/players"), "allow")
  assert.equal(p.decide("https://api.freakrating.lol/x"), "allow")
  assert.equal(p.decide("http://freakrating.lol/"), "external")
  assert.equal(p.decide("https://freakrating.lol.evil.com/"), "external")
  assert.equal(p.decide("https://youtube.com/watch"), "external")
  assert.equal(p.decide("file:///etc/passwd"), "deny")
  assert.equal(p.decide("javascript:alert(1)"), "deny")
})

test("twitch.tv в окне только внутри OAuth-входа", () => {
  const p = new NavigationPolicy("https://freakrating.lol/world")
  assert.equal(p.decide("https://www.twitch.tv/somechannel"), "external")
  assert.equal(p.decide("https://id.twitch.tv/oauth2/authorize?client_id=x"), "allow")
  assert.equal(p.decide("https://www.twitch.tv/login"), "allow")
  assert.equal(p.decide("https://freakrating.lol/auth/user/twitch/callback?code=1"), "allow")
  assert.equal(p.decide("https://www.twitch.tv/somechannel"), "external")
})

test("дев-адрес из --url — свой", () => {
  const p = new NavigationPolicy("http://localhost:4000/world")
  assert.equal(p.decide("http://localhost:4000/dev/login/x"), "allow")
  assert.equal(p.decide("http://localhost:4001/"), "external")
  assert.ok(p.isAppUrl("https://freakrating.lol/world"))
})

test("путь мира", () => {
  assert.ok(isWorldPath("https://freakrating.lol/world"))
  assert.ok(isWorldPath("http://localhost:4000/world/lobby?x=1"))
  assert.ok(!isWorldPath("https://freakrating.lol/worlds"))
})

test("следующий графический режим", () => {
  assert.equal(nextBackend("auto", "win32"), "vulkan")
  assert.equal(nextBackend("vulkan", "win32"), "gl")
  assert.equal(nextBackend("gl", "win32"), "d3d11")
  assert.equal(nextBackend("auto", "linux", {}), "vulkan")
  assert.equal(nextBackend("auto", "linux", { WAYLAND_DISPLAY: "wayland-1" }), null)
  assert.deepEqual(availableBackends("linux", { XDG_SESSION_TYPE: "wayland" }), ["auto", "gl"])
})

test("битые настройки — значения по умолчанию", () => {
  const s = sanitize({ graphicsBackend: "metal", preferDiscreteGpu: "yes", ptt: { type: "mouse", button: 1, label: "ЛКМ" } })
  assert.equal(s.graphicsBackend, "auto")
  assert.equal(s.preferDiscreteGpu, true)
  assert.equal(s.ptt.label, "F8")
  assert.equal(sanitize({ ptt: null }).ptt, null)
})

test("статус Discord от страницы чистится", () => {
  const p = sanitizePresence({ details: "x".repeat(500), state: "1", evil: 1, buttonUrl: "https://evil.com", startTimestamp: -5 })
  assert.equal(p.details.length, 128)
  assert.equal(p.state, "1 ")
  assert.equal(p.buttonUrl, undefined)
  assert.equal(p.startTimestamp, undefined)
  assert.equal("evil" in p, false)
  assert.equal(sanitizePresence({ buttonUrl: "https://freakrating.lol/world" }).buttonLabel, "FreakRating")
  assert.equal(sanitizePresence("nope"), null)
})

test("флаги запуска", () => {
  assert.equal(parseCli([], {}).url, "https://freakrating.lol/world")
  assert.equal(parseCli(["--url=http://localhost:4000/world"], {}).url, "http://localhost:4000/world")
  assert.equal(parseCli([], { FREAK_URL: "http://x/world" }).url, "http://x/world")
})

test("видимость окна: событие только при смене", () => {
  const v = new WindowVisibility()
  const win = (minimized, visible) => ({ isMinimized: () => minimized, isVisible: () => visible })
  assert.equal(v.update(win(false, true)), null)
  assert.equal(v.update(win(true, true)), true)
  assert.equal(v.current, true)
  assert.equal(v.update(win(true, false)), null)
  assert.equal(v.update(win(false, true)), false)
  assert.equal(v.update(win(false, false)), true)
  assert.equal(v.update(win(false, true)), false)
})
