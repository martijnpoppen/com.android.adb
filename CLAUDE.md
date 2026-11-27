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

- Reported working by a community user (Peter_Kawa, forum topic 162642, post 4) on a
  Samsung Galaxy Tab A9+ and a Galaxy S21+. No detail on which features or One UI version;
  the Samsung "Auto Blocker" tip in the pairing help is still unconfirmed.
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
- Brightness on Samsung (GS21+ Android 15, Tab A9+ Android 16, reported by Peter_Kawa): with
  the 8191 start 1% gave a 25% slider, 3% gave 95%, 4% and up 100%, so raw is 0..255 there and
  the scale was never learned (the float evidently doesn't follow raw; diag log not seen). Now
  `ro.product.manufacturer` = samsung (read in the state command and in CMD_BRIGHTNESS, for
  keep-alive off) fixes the scale at 255, over any stored value. NOT confirmed on a Samsung
  yet. `cmd overlay lookup android android:integer/config_screenBrightnessSettingMaximum` is
  only logged ("the platform reports ..."), to see what other brands say before trusting it.
- Volume: setting it works on the OnePlus (user confirmed); setVolume tries media_session,
  `cmd audio set-volume`, then volume key presses, verified via the AudioService reading,
  and remembers the first that sticks. Which one the OnePlus uses is not logged back yet.
- User reported OK on the OnePlus 9 ("rest is ok"): battery level and charging state, and the
  Flow cards open app, open link, press button, type text, keep screen on while charging,
  screen timeout, is charging, app is open on screen.
- Also confirmed by the user on the OnePlus 9: regular state checks with keep-alive on, and
  following the Wireless debugging port after toggling it (mDNS).
- Only tested against the mock, NOT on a real device: repair flow, and the batch below.
- Batch added (mock only, real output formats unconfirmed):
  - Triggers `foreground_app_changed` (tokens name, package) and `wifi_network_changed`; not
    fired on the first state reading (`stateSeen` / `foregroundPackage`).
  - `take_screenshot`: `screencap -p` through `AdbClient.exec()` (raw bytes), one Homey Image
    per device (`setCameraImage`). Screen must be on. The image stream takes a NEW screenshot
    on every load (refresh in the app), except within 5 s of `takeScreenshot()` (card or the
    `screenshot_button` capability), whose `image.update()` makes Homey reload it.
  - `take_photo` (user: "photo works" on the OnePlus 9 after volume up + tap were added;
    which shutter method fires and whether front/back is respected was not reported): wake,
    `am start -a android.media.action.STILL_IMAGE_CAMERA` with unofficial front/back extras,
    `touch` a marker file, then try shutter methods (KEYCODE_CAMERA, VOLUME_DOWN, VOLUME_UP,
    tap at 50% x / 87% y of `wm size`) until `find /sdcard/DCIM /sdcard/Pictures -newer
    <marker>` shows a new .jpg (the working method is remembered), wait for a stable size,
    `cat` it via `exec()`, press BACK, then `am force-stop` the camera app (= the app that
    came to the front after the start, if different from before; the user asked for this).
    Buttons `photo_button_back` / `photo_button_front` on the device do the same. Real
    OnePlus 9 (com.oplus.camera): KEYCODE_CAMERA and VOLUME_DOWN produce no picture. Second
    camera image 'photo' (1x1 placeholder until one is taken; kept on disk); loading it never
    opens the camera.
    Samsung stock camera (GS21+ Android 15, Tab A9+ Android 16, reported by Peter_Kawa):
    ignores the facing extras and keeps its last lens. So after the start `parseOpenCamera`
    reads the open lens from `dumpsys media.camera` (static "Facing:" per camera id + "Device
    <id> is open"; fallback id 0 = back, 1 = front) and, if wrong, swipes vertically over the
    preview (Samsung's "swipe up/down to switch cameras", on by default) and logs the result.
    Mock only: the real dumpsys format and the swipe are NOT confirmed on a Samsung.
  - Triggers `screenshot_taken` / `photo_taken` (image token): fired by `takeScreenshot()` /
    `takePhoto()` only (button or card), never by an image reload, or a Flow using the image
    would trigger itself.
  - Action cards must NOT declare `tokens`: Homey then only shows them in Advanced Flow (the
    user couldn't find the screenshot card). Images: `setCameraImage('screenshot'|'photo')`
    already gives an image tag under the DEVICE in every Flow (like a camera's "Snapshot");
    don't add app-level image tokens (the user found those odd). Only the shell output is an
    app-level tag "Output (<device>)" (`homey.flow.createToken`, title = name at app start).
  - `show_url` / `show_app`: wake, `wm dismiss-keyguard`, then open. `close_app` = `am
    force-stop`. `tap_screen` / `swipe_screen` = `input tap|swipe`.
  - `set_stream_volume` (ring 2, alarm 4, notification 5): media_session then `cmd audio
    set-volume`, verified; errors if neither sticks (likely on the OnePlus, where
    media_session --set is ignored for media).
  - Sensors `screen_timeout` (s), `stay_awake`, `storage_free` (GB, `df -k /data`).
  - Media: system capabilities `speaker_playing/next/prev/track/artist/album`; state from
    `dumpsys media_session | grep -E 'state=PlaybackState|metadata:'` (`parseMedia`), control
    with KEYCODE_MEDIA_* key events.
  - `lib/AppNames.js`: readable app names = list of well-known packages + a guess from the
    package name. Android has no cheap way to read real app labels over ADB.
- Added (user: "works" on the OnePlus 9, no per-card detail given): Bluetooth on/off (`cmd bluetooth_manager enable|disable`, fallback
  `svc bluetooth`; verified via `settings get global bluetooth_on`), condition + triggers
  "Bluetooth turned on/off" (not fired on the first reading after start); restart via adbd's
  `reboot:` service (Tango `adb.power.reboot()`, 10 s limit, the phone just drops the
  connection; Wireless debugging is off afterwards); Do Not Disturb via `cmd notification
  set_dnd off|priority|alarms|none`, verified via `settings get global zen_mode` (0/1/3/2);
  auto-rotate via `settings put system accelerometer_rotation`; notification via `cmd
  notification post -S bigtext -t <title> <tag> <text>` (appears as the Shell app, unique tag
  so they stack); battery temperature (`measure_temperature`) from `dumpsys battery`.
- Sensor tab (user: "works perfect" on the OnePlus 9, incl. Wi-Fi): custom capabilities in `.homeycompose/capabilities/` (sensor UI,
  icons in `assets/capabilities/`, Bootstrap Icons): `bluetooth_enabled`, `auto_rotate`,
  `dnd_mode` (translated text from `locales` `dnd.*`), `wifi_network`, `foreground_app`, plus
  the system `measure_signal_strength` (Wi-Fi RSSI, dBm). All read in the one state command.
  Wi-Fi comes from `cmd wifi status | grep SSID:` (fallback `dumpsys wifi | grep mWifiInfo`);
  unparsed lines are logged as "Could not read Wi-Fi from". The mock's state branches must be guarded with `single`,
  because the combined state command contains the same words as the single commands.
- Not possible / left out on purpose: Wi-Fi off and airplane mode (would cut Homey's own
  connection), hardware sensors like light/proximity (Android only reports them to an app that
  is listening).
- Per-brand menu paths in the pairing help were written from memory; verify on real devices.

## Git

- Commit straight to `main` (the user's choice).

## Gotchas

- "Keep the connection open" OFF means NO state checks at all (the user's definition): only
  connect for a command, read the state right after it (`pollSoon`), disconnect. The only
  exception: while the device is unreachable it retries every 30 s, or it would stay
  unavailable for good. The two check-interval settings only apply with keep-alive on.
- Memory (Peter_Kawa: 67 → 120 MB in two days with two devices, rising in steps): large
  transfers were the suspect, not a classic leak. `AdbClient` joined its receive buffer on
  every 16 kB piece (~32 MB allocated per MB received); it now collects pieces and joins once
  per packet. The last photo lives in `/userdata/photo-<id>.jpg` (os.tmpdir() in the tests),
  not in memory, and so survives an app restart; the screenshot buffer is dropped after its
  5 s of reuse. Effect on a real Homey NOT measured yet.
- The mock's `big` reply (3.25 MB, checked byte for byte via `shell()` and `exec()`) is the
  only test of the receive path with packets split over many pieces; keep it.
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

- Real app labels (would need a helper app on the device or pulling APKs)
- Flashlight, Wi-Fi off / airplane mode (the latter two cut Homey's own connection)
- A card that opens a Homey dashboard directly (dashboards only exist in the Homey mobile app;
  needs a deep link, unknown)
