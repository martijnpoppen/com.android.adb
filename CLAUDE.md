# Android Control — Homey app

Homey Pro app (SDK v3, CommonJS, local only) that controls Android phones/tablets over the
network with a pure-JavaScript ADB client. No adb binary, no adb server.

## Commands

- `npm install` — dependencies (the `homey` module itself is provided by the Homey runtime)
- `npx homey app run --remote` — run on the Homey with live logs. Without `--remote` a Homey
  Pro 2023+ runs the app in Docker on the machine running the CLI, which must then be on the
  same LAN as the phone.
- `npx homey app validate --level publish` — must pass before handing over
- `node test/mock.js` — classic ADB (port 5555, RSA auth) against a mock adbd
- `node test/mock-tls.js` — Wireless debugging (pairing code + TLS) against a mock device,
  plus the Driver/Device classes with a stubbed Homey SDK, plus a check that every text exists
  in all 13 Homey languages

## Layout

- `.homeycompose/` — manifest sources. HIDDEN folder: copy with the terminal, not Finder.
  `app.json` in the root is generated from it; never edit `app.json` by hand.
- `.homeycompose/discovery/adb-tls.json` — mDNS `_adb-tls-connect._tcp`, used to follow the
  random Wireless debugging port.
- `lib/AdbClient.js` — TCP connection, in-place STLS → TLS 1.3 upgrade, `shell()`,
  optional idle disconnect. Wraps Tango (`@yume-chan/adb`), which is ESM-only and
  therefore loaded with dynamic `import()`.
- `lib/AdbPairing.js` — `adb pair` equivalent: TLS + SPAKE2 + AES-128-GCM PeerInfo exchange.
- `lib/Spake2.js` — BoringSSL-compatible SPAKE2 (exact, unreduced scalars on purpose; M/N are
  not torsion-free).
- `lib/Certificate.js` — hand-rolled self-signed X.509 from the ADB RSA key (the device only
  compares the public key).
- `lib/CredentialStore.js` — one RSA key for the whole app, stored in `homey.settings`. Key name
  (shown on the phone under Paired devices) is "Homey": the app SDK has no call for the
  Homey's own name (`homey.cloud.getHomeyName` does not exist; only the Web API with
  `homey:manager:api` has it, and the user chose not to add that permission for this).
- `drivers/tablet/` — driver, device, settings, Flow cards. Pairing and repair open on
  `connect.html` (the form). Its "How do I pair my device?" link opens `instructions.html`
  (brand picker + steps) with `Homey.showView()`; Homey's own back button returns
  (`navigation.prev` on the instructions view only). No Next/Previous buttons, on purpose.
  `pair/` and `repair/` must stay identical. They hold no text: all strings come from
  `locales/<lang>.json` (`pair.*`) via `Homey.__()`. The steps say "go back to the form".
- `lib/errors.js` — library errors carry a `code` (`ADB_NOT_PAIRED`, `ADB_PAIRING_FAILED`,
  `ADB_AUTH_TIMEOUT`, `ADB_UNREACHABLE`, ECONNREFUSED, ...) and an English message for the
  logs; `localizeError()` turns them into `errors.*` from the locales for the user.

## Translations

- Languages = the ones Homey itself ships: en, nl, de, fr, it, sv, no, es, da, ru, pl, ko, ar.
  Every manifest text, every key in `locales/en.json` and `README.txt` (as `README.<lang>.txt`)
  must exist in all of them; `node test/mock-tls.js` fails otherwise.
- Adding or changing an English text means updating all 12 other languages in the same change.
- Keep `[[arg]]`, `__token__`, `!{{a|b}}` and HTML tags identical to English.
- Android menu names in the pairing help are the localized Android names, from knowledge, not
  checked on devices in those languages.

## Look

- brandColor `#188649`: Android green's hue, darkened so a white icon on it passes WCAG AA
  (4.6:1). Homey shows the icons on this color. Plain Android green #3DDC84 is only 1.8:1.
- `assets/icon.svg` (app: phone + power symbol + signal) and
  `drivers/tablet/assets/icon.svg` (Bootstrap Icons `phone`, MIT, scaled to 960; the user
  prefers it over an angled drawing) must stay
  different: Homey rejects an app icon reused as a driver icon or the other way round.
  Both 960x960 canvas, transparent, no gradients or filled backgrounds.
- Store images are drawn, not photos. Homey prefers lifestyle photos and frowns on plain
  app-screen images; a real photo of a wall tablet/phone in use would be safer for review.

## Protocol facts (from the AOSP adb source)

- Pairing: TLS 1.3 to the pairing port, client cert sent, server cert not verified.
  Password = pairing code bytes + 64 bytes exported keying material, label `"adb-label\0"`.
  SPAKE2 names `"adb pair client\0"` / `"adb pair server\0"`. AES key = HKDF-SHA256 of the
  SPAKE2 output, info `"adb pairing_auth aes-128-gcm key"`, 16 bytes. Nonce = 64-bit LE
  counter, zero padded to 12. Packet header: version(1)=1, type(1), length(4, big endian).
  PeerInfo: 8192 bytes, type 0 + `"<base64 adb pubkey> <name>"`.
- Connect: plain CNXN → device answers STLS → we send STLS → TLS on the same socket →
  device sends CNXN (no AUTH step). Unknown key = device just closes the connection.

## Status

- Confirmed on a real OnePlus 9 (Android 14, OxygenOS) by the user: pairing with code and
  connecting over Wireless debugging, the two-page pairing view, keep-alive off (connect /
  idle-disconnect logged), state check slowing to 300 s with the screen off on battery,
  pressing the volume keys, reading and setting volume, and setting brightness with the
  slider (raw setting, scale 8191; confirmed after the "start at 8191" change).
- Real OnePlus 9 replies (the mock copies them): `cmd display get-brightness` → "Unknown
  command"; raw `screen_brightness` goes up to 8191; media volume range 0..30.
  `cmd display set-brightness`, `settings put system screen_brightness_float` and
  `cmd media_session volume --set` are accepted but change nothing.
- Brightness: writing the raw `screen_brightness` setting works on the OnePlus (user: 400 =
  dark, 6000 = bright, 9999 = brightest, so capped at 8191). setBrightness turns adaptive
  brightness off, writes raw = level × scale, and reads raw back for the slider. Scale starts
  at 8191 (guessing 255 from a low current raw value left the OnePlus stuck dark). If the
  phone mirrors raw into `screen_brightness_float` (stored as `brightnessMirrors` the first
  time the float follows a write), the scale is learned: raw ÷ float, or the written raw
  while the float sits at 1.0 (saturated), up to 8 rounds; stored as `brightnessScale`.
  Whether the OnePlus mirrors is NOT confirmed. Never verify a setting by reading the same
  setting back: that always "works".
- Volume: setting it works on the OnePlus (user confirmed); setVolume tries media_session,
  `cmd audio set-volume`, then volume key presses, verified via the AudioService reading,
  and remembers the first that sticks. Which one the OnePlus uses is not logged back yet.
- User reported OK on the OnePlus 9 ("rest is ok"): battery level and charging state, and the
  Flow cards open app, open link, press button, type text, keep screen on while charging,
  screen timeout, is charging, app is open on screen.
- Only tested against the mock, NOT on a real device: mDNS port following, repair flow,
  state checks with keep-alive on.
- Per-brand menu paths in the pairing help were written from memory; verify on real devices.

## Git

- Commit straight to `main` (the user's choice).

## Gotchas

- "Keep the connection open" OFF means NO state checks at all (the user's definition): only
  connect for a command, read the state right after it (`pollSoon`), disconnect. The only
  exception: while the device is unreachable it retries every 30 s, or it would stay
  unavailable for good. The two check-interval settings only apply with keep-alive on.
- `Device.poll()` is single-flight; never `await this.poll()` from code that runs inside a
  poll (it waits on itself). Use `this.poll().catch(this.error)`.
- `this.config` mirrors the device settings; update it together with `setSettings()`.
- Everything interpolated into a shell command must be validated or passed through `quote()`.
- `AdbClient` emits `connect` ({ secure, purpose }: the shell command that caused it, or the
  `purpose` option, e.g. 'state check') and exactly one `disconnect` ({ reason: idle | error |
  device | requested }) per connection; the device logs both. `disconnect()` clears `this.adb`
  before Tango's `disconnected` fires, so that handler must not be the one to emit for it.
- Android turns Wireless debugging off on reboot; the pairing itself survives.
- App id is `com.android.adb` (changed from `com.example.adbtablet`: devices paired under the old id must be paired again). Author: Martijn Poppen <adb@martijnpoppen.nl>.

## Ideas not built yet

- Flow trigger when the foreground app changes
- Screenshot into a Homey image token
- "Screen on with dashboard" button
- Friendly app names instead of package names
