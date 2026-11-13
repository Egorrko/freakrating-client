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
const { EscapeGesture } = require("../dist/main/escape.js")

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

test("Esc: придержать, дать активацию, отдать по порядку", async () => {
  const log = []
  let esc
  let release
  const target = {
    grantGesture: () => {
      log.push("grant")
      return new Promise((r) => (release = r))
    },
    // Свой повтор приходит в before-input-event синхронно — его не придерживаем.
    resend: (type, modifiers) => {
      assert.equal(esc.handle({ type, key: "Escape" }), false)
      log.push(`${type}:${modifiers.join("+")}`)
    },
  }
  esc = new EscapeGesture(target, 50)
  assert.equal(esc.handle({ type: "keyDown", key: "a" }), false)
  assert.equal(esc.handle({ type: "char", key: "Escape" }), false)
  assert.equal(esc.handle({ type: "keyDown", key: "Escape", shift: true }), true)
  assert.equal(esc.handle({ type: "keyUp", key: "Escape" }), true)
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(log, ["grant"], "keyup не обгоняет keydown, пока нет активации")
  release()
  await esc.idle()
  assert.deepEqual(log, ["grant", "keyDown:shift", "grant", "keyUp:"])
})

test("Esc: автоповтор без активации, зависшая страница не держит клавишу", async () => {
  const log = []
  const esc = new EscapeGesture(
    {
      grantGesture: () => {
        log.push("grant")
        return new Promise(() => {})
      },
      resend: (type, modifiers) => log.push(`${type}:${modifiers.join("+")}`),
    },
    10,
  )
  esc.handle({ type: "keyDown", key: "Escape", isAutoRepeat: true })
  esc.handle({ type: "keyDown", key: "Escape" })
  await esc.idle()
  assert.deepEqual(log, ["keyDown:isautorepeat", "grant", "keyDown:"])
})

test("показ экрана: Wayland — окно портала, иначе своё; звук по ОС", () => {
  const { sourceMode, screenAudioKind } = require("../dist/main/screenShare.js")
  assert.equal(sourceMode("linux", { XDG_SESSION_TYPE: "wayland" }), "portal")
  assert.equal(sourceMode("linux", { WAYLAND_DISPLAY: "wayland-1" }), "portal")
  assert.equal(sourceMode("linux", { XDG_SESSION_TYPE: "x11" }), "picker")
  assert.equal(sourceMode("win32", {}), "picker")
  assert.equal(screenAudioKind("win32"), "loopback")
  assert.equal(screenAudioKind("linux"), "virtual-mic")
  assert.equal(screenAudioKind("darwin"), "none")
})

test("окно выбора: экраны по-русски", () => {
  const { screenName } = require("../dist/main/screenShare.js")
  assert.equal(screenName(0, 1), "Весь экран")
  assert.equal(screenName(1, 2), "Экран 2")
})

test("typeperf: движки 3D по процессам складываются, пустые — null", () => {
  const { parseTypeperf } = require("../dist/main/profile.js")
  const csv = [
    '"(PDH-CSV 4.0) (RTZ)(0)","\\\\PC\\GPU Engine(pid_10_luid_0x0_phys_0_eng_0_engtype_3D)\\Utilization Percentage","\\\\PC\\GPU Engine(pid_20_luid_0x0_phys_0_eng_0_engtype_3D)\\Utilization Percentage","\\\\PC\\Processor Information(_Total)\\% Processor Performance","\\\\PC\\Thermal Zone Information(\\_TZ.TZ00)\\Temperature"',
    '"11/14/2026 04:30:01.000","40.5","12.25","61.3","3332"',
    '"11/14/2026 04:30:02.000","50","","58",""',
    "Exiting, please wait...",
  ].join("\r\n")
  assert.deepEqual(parseTypeperf(csv), [
    { counter: "GPU Engine 3D\\Utilization Percentage", values: [52.8, 50] },
    { counter: "Processor Information(_Total)\\% Processor Performance", values: [61.3, 58] },
    { counter: "Thermal Zone Information(\\_TZ.TZ00)\\Temperature", values: [3332, null] },
  ])
  assert.deepEqual(parseTypeperf(""), [])
})
