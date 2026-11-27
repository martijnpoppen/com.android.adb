'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Homey = require('homey');
const AdbClient = require('../../lib/AdbClient');
const { localizeError } = require('../../lib/errors');
const { appName } = require('../../lib/AppNames');

const CAPABILITIES = ['onoff', 'dim', 'volume_set', 'measure_battery', 'battery_charging_state', 'measure_temperature',
  'bluetooth_enabled', 'auto_rotate', 'dnd_mode', 'wifi_network', 'measure_signal_strength', 'foreground_app',
  'screen_timeout', 'stay_awake', 'storage_free',
  'speaker_playing', 'speaker_prev', 'speaker_next', 'speaker_track', 'speaker_artist', 'speaker_album',
  'screenshot_button', 'photo_button_back', 'photo_button_front'];
const VOLUME_STREAMS = { ring: 2, alarm: 4, notification: 5 }; // AudioManager.STREAM_*
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
// 1x1 transparent PNG, shown as the photo until one is taken.
const EMPTY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// New photos are found as "files newer than a marker file", wherever the camera app saves them.
const PHOTO_MARKER = '/data/local/tmp/homey_photo_marker';
const CMD_NEW_PHOTOS = `find /sdcard/DCIM /sdcard/Pictures -type f -newer ${PHOTO_MARKER} 2>/dev/null | head -5`;
// Ways to press the shutter; which one works differs per phone and camera app.
// 'tap' taps where camera apps put the shutter button: bottom centre of the screen.
// (OnePlus 9, com.oplus.camera: the camera key and volume down do nothing.)
const SHUTTER_METHODS = ['KEYCODE_CAMERA', 'KEYCODE_VOLUME_DOWN', 'KEYCODE_VOLUME_UP', 'tap'];
const DND_MODES = { 0: 'off', 1: 'priority', 2: 'none', 3: 'alarms' }; // settings global zen_mode

const CMD_SCREEN_ON = 'input keyevent KEYCODE_WAKEUP';
const CMD_SCREEN_OFF = 'input keyevent KEYCODE_SLEEP';
const CMD_DISMISS_KEYGUARD = 'wm dismiss-keyguard';
// With "Keep the connection open" off: hang up this long after the last command.
const IDLE_DISCONNECT_MS = 5000;
const DISCONNECT_REASONS = {
  idle: `idle for ${IDLE_DISCONNECT_MS / 1000} s ("Keep the connection open" is off)`,
  error: 'a command failed',
  device: 'closed by the device',
  requested: 'closed by Homey',
};
// While the device can't be reached, try again at most this often.
const RETRY_SECONDS = 30;

const CMD_VOLUME = '(cmd media_session volume --stream 3 --get 2>/dev/null || media volume --stream 3 --get 2>/dev/null)';
const CMD_BRIGHTNESS = 'echo mode=$(settings get system screen_brightness_mode); '
  + 'echo float=$(settings get system screen_brightness_float); echo raw=$(settings get system screen_brightness); '
  + 'echo brand=$(getprop ro.product.manufacturer); '
  // What the platform itself calls the top of the raw scale. Only logged, to learn what brands report.
  + 'echo platform_max=$(cmd overlay lookup android android:integer/config_screenBrightnessSettingMaximum 2>/dev/null)';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Everything Homey shows is read in one go, to keep polling light.
const CMD_STATE = [
  'dumpsys power | grep mWakefulness=',
  "dumpsys battery | grep -E 'level:|status:|powered:|temperature:'",
  'echo bluetooth=$(settings get global bluetooth_on)',
  'echo rotation=$(settings get system accelerometer_rotation)',
  'echo zen=$(settings get global zen_mode)',
  // e.g. 'WifiInfo: SSID: "Home", BSSID: ..., RSSI: -55, ...'. 'cmd wifi' is Android 11+.
  "echo wifi=$(cmd wifi status 2>/dev/null | grep -m1 'SSID:' || dumpsys wifi | grep -m1 'mWifiInfo')",
  "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'",
  'echo brightness_float=$(settings get system screen_brightness_float 2>/dev/null)',
  'echo brightness_raw=$(settings get system screen_brightness)',
  'echo brand=$(getprop ro.product.manufacturer)',
  'echo timeout=$(settings get system screen_off_timeout)',
  'echo stayon=$(settings get global stay_on_while_plugged_in)',
  'echo storage=$(df -k /data | tail -1)',
  "dumpsys media_session | grep -E 'state=PlaybackState|metadata:'",
  CMD_VOLUME,
].join('; ');

// Which camera is in use: the static part lists each camera's facing, the dynamic part which one is open.
const CMD_OPEN_CAMERA = "dumpsys media.camera | grep -E 'static information|Facing:|is open'";

/**
 * 'back' or 'front' for the camera that is open, null when none is or it can't be told.
 * @param {string} output of CMD_OPEN_CAMERA
 */
function parseOpenCamera(output) {
  const facing = {};
  let id = null;
  let open = null;
  for (const line of String(output).split('\n')) {
    const info = line.match(/([^\s/]+) \(v[\d.]+\) static information/);
    const face = line.match(/Facing:\s*(Back|Front)/i);
    const opened = line.match(/Device (\S+) is open/);
    if (info) [, id] = info;
    else if (face && id !== null && !facing[id]) facing[id] = face[1].toLowerCase();
    else if (opened && open === null) [, open] = opened;
  }
  if (open === null) return null;
  // Without the list: ids 0 and 1 are back and front on about every device.
  return facing[open] || { 0: 'back', 1: 'front' }[open] || null;
}

/** Package name of the app in front, from 'dumpsys window' focus lines. */
function parseForegroundApp(output) {
  const match = output.match(/mCurrentFocus=.*?\s([\w.]+)\/[^\s}]*/) || output.match(/mFocusedApp=.*?\s([\w.]+)\/[^\s}]*/);
  return match ? match[1] : null;
}

/**
 * What is playing, from 'dumpsys media_session' lines like
 *   state=PlaybackState {state=PLAYING(3), position=...     (Android 14; older: state=3)
 *   metadata: size=12, description=Title, Artist, Album
 * A playing session wins; otherwise the first one that has a title.
 * @returns {{ playing: boolean, track?: string, artist?: string, album?: string } | null}
 */
function parseMedia(output) {
  const sessions = [];
  let state = null;
  for (const line of output.split('\n')) {
    const stateMatch = line.match(/state=PlaybackState \{state=(?:[A-Z_]+\()?(\d+)/);
    if (stateMatch) state = Number(stateMatch[1]);
    const meta = line.match(/metadata:\s*size=\d+, description=(.*)$/);
    if (meta) {
      const parts = meta[1].trim().split(', ').map((part) => (part === 'null' ? '' : part));
      // Titles can contain ", " themselves: artist and album are the last two parts.
      const album = parts.length >= 3 ? parts.pop() : '';
      const artist = parts.length >= 2 ? parts.pop() : '';
      sessions.push({ playing: state === 3, track: parts.join(', '), artist, album });
      state = null;
    }
  }
  if (!sessions.length) return state === null ? null : { playing: state === 3 };
  return sessions.find((s) => s.playing) || sessions.find((s) => s.track) || sessions[0];
}

/** Quotes a value for use as a single shell argument on the device. */
function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

class TabletDevice extends Homey.Device {

  async onInit() {
    this.config = { ...this.getSettings() };
    const { host, port } = this.config;
    this.log(`Init, using ${host}:${port}`);

    // Devices added with an older version of the app get the new capabilities.
    for (const capability of CAPABILITIES) {
      if (!this.hasCapability(capability)) await this.addCapability(capability);
    }

    this.volumeMax = 15;
    this.createClient({ host, port });

    const translated = (set) => (value) => set(value).catch((err) => { throw this.localizeError(err); });
    this.registerCapabilityListener('onoff', translated((value) => this.setScreen(value)));
    this.registerCapabilityListener('dim', translated((value) => this.setBrightness(value)));
    this.registerCapabilityListener('volume_set', translated((value) => this.setVolume(value)));
    this.registerCapabilityListener('speaker_playing', translated((value) => this.pressKey(value ? 'KEYCODE_MEDIA_PLAY' : 'KEYCODE_MEDIA_PAUSE')));
    this.registerCapabilityListener('speaker_next', translated(() => this.pressKey('KEYCODE_MEDIA_NEXT')));
    this.registerCapabilityListener('speaker_prev', translated(() => this.pressKey('KEYCODE_MEDIA_PREVIOUS')));

    // One image per device: shown on the device in Homey and returned by the screenshot card.
    this.screenshotImage = await this.homey.images.createImage();
    // Every time Homey loads the image (also "refresh" in the app) it is a new
    // screenshot, except right after takeScreenshot(), which just made one.
    this.screenshotImage.setStream(async (stream) => {
      const fresh = this.screenshot && Date.now() - this.screenshotTime < 5000;
      stream.contentType = 'image/png';
      stream.end(fresh ? this.screenshot : await this.captureScreen());
    });
    // Photos from the camera: only ever the last one taken (loading never opens the camera).
    this.photoFile = path.join(fs.existsSync('/userdata') ? '/userdata' : os.tmpdir(), `photo-${String(this.getData().id).replace(/[^\w.-]/g, '_')}.jpg`);
    this.photoImage = await this.homey.images.createImage();
    this.photoImage.setStream(async (stream) => {
      // The last photo is kept on disk, not in memory (several MB per device).
      if (fs.existsSync(this.photoFile)) {
        stream.contentType = 'image/jpeg';
        fs.createReadStream(this.photoFile).on('error', (err) => stream.destroy(err)).pipe(stream);
      } else {
        stream.contentType = 'image/png';
        stream.end(EMPTY_PNG); // nothing taken yet
      }
    });
    this.registerCapabilityListener('screenshot_button', translated(() => this.takeScreenshot()));
    this.registerCapabilityListener('photo_button_back', translated(() => this.takePhoto('back')));
    this.registerCapabilityListener('photo_button_front', translated(() => this.takePhoto('front')));
    await this.setCameraImage('screenshot', this.homey.__('device.screenshot'), this.screenshotImage).catch(this.error);

    // Homey turns every camera image into an image tag under the device, for all Flows.
    await this.setCameraImage('photo', this.homey.__('device.photo'), this.photoImage).catch(this.error);

    // Text has no such thing: the shell output is an app-level tag, named after the device.
    const id = this.getData().id;
    this.shellToken = await this.homey.flow.createToken(`shell_output_${id}`, {
      type: 'string', title: `${this.homey.__('device.shell_output')} (${this.getName()})`, value: '',
    });

    this.poll().catch(this.error);
  }

  createClient({ host, port }) {
    if (this.client) {
      const old = this.client;
      old.disconnect().catch(this.error).finally(() => old.removeAllListeners());
    }
    this.client = new AdbClient({
      host,
      port,
      credentialStore: this.driver.credentialStore,
      idleTimeout: this.config.keep_alive === false ? IDLE_DISCONNECT_MS : 0,
    });
    this.client.on('connect', ({ secure, purpose }) => {
      const why = purpose && purpose.length > 80 ? `${purpose.slice(0, 80)}...` : purpose;
      this.log(`ADB connected to ${host}:${port} (${secure ? 'Wireless debugging' : 'classic ADB'}) for: ${why || '?'}`);
    });
    this.client.on('disconnect', ({ reason }) => this.log(`ADB disconnected: ${DISCONNECT_REASONS[reason] || reason}`));
  }

  /**
   * Seconds until the next state check, or 0 for "don't check".
   * Checking wakes the device, so it backs off when nobody is using it.
   */
  nextPollDelay() {
    const active = Math.max(5, Number(this.config.poll_interval) || 15);
    // Unreachable: keep retrying, or the device would stay unavailable for good.
    // A failed attempt doesn't wake the device.
    if (this.lastError) return Math.max(active, RETRY_SECONDS);
    // Keep-alive off = no checks at all: only read the state right after a command.
    if (this.config.keep_alive === false) return 0;
    const inUse = this.getCapabilityValue('onoff') !== false || this.pluggedIn !== false;
    if (inUse) return active;
    const idle = Number(this.config.poll_interval_idle);
    if (Number.isNaN(idle)) return 300;
    return idle <= 0 ? 0 : Math.max(active, idle);
  }

  scheduleNextPoll() {
    this.homey.clearTimeout(this.pollTimer);
    const seconds = this.nextPollDelay();
    if (this.pollDelay !== seconds) {
      this.log(seconds ? `Checking state every ${seconds} s` : 'State checks paused until the next command');
      this.pollDelay = seconds;
    }
    if (!seconds) return;
    this.pollTimer = this.homey.setTimeout(() => {
      this.poll().catch(this.error);
    }, seconds * 1000);
  }

  pollSoon() {
    this.homey.clearTimeout(this.pollTimer);
    this.pollTimer = this.homey.setTimeout(() => this.poll().catch(this.error), 1500);
  }

  /* ----- Controls ----- */

  async setScreen(on) {
    this.log(`Turning screen ${on ? 'on' : 'off'}`);
    await this.client.shell(on ? CMD_SCREEN_ON : CMD_SCREEN_OFF);
    if (on && this.config.dismiss_keyguard) {
      await this.client.shell(CMD_DISMISS_KEYGUARD);
    }
    this.pollSoon();
  }

  /**
   * Runs apply(value) for the newest value only: while a slider is dragged,
   * values that arrive during a run are collapsed into one more run.
   */
  async latest(name, value, apply) {
    this.latestRuns = this.latestRuns || {};
    const run = this.latestRuns[name] || (this.latestRuns[name] = { target: null, running: null });
    run.target = value;
    if (!run.running) {
      run.running = (async () => {
        try {
          let done;
          do {
            done = run.target;
            await apply(done);
          } while (run.target !== done);
        } finally {
          run.running = null;
        }
      })();
    }
    return run.running;
  }

  /** @returns {Promise<{ mode: number|null, float: number|null, raw: number|null }>} */
  async readBrightness() {
    const output = await this.client.shell(CMD_BRIGHTNESS, { purpose: 'brightness' });
    const get = (key) => {
      const match = output.match(new RegExp(`^${key}=([\\d.]+)\\s*$`, 'm'));
      return match ? Number(match[1]) : null;
    };
    this.noteBrand(output);
    const platformMax = get('platform_max');
    if (platformMax !== null && platformMax !== this.platformBrightnessMax) {
      this.platformBrightnessMax = platformMax;
      this.log(`Brightness: the platform reports ${platformMax} as the top of the raw scale (${this.brand || 'unknown brand'}), using ${this.rawBrightnessMax()}`);
    }
    return { mode: get('mode'), float: get('float'), raw: get('raw') };
  }

  /** Remembers the manufacturer from a 'brand=' line; the raw brightness scale depends on it. */
  noteBrand(output) {
    const brand = output.match(/^brand=(.+?)\s*$/m);
    if (brand) this.brand = brand[1].toLowerCase();
  }

  /** Samsung: raw brightness is 0..255 and the float setting doesn't follow it, so nothing can be learned. */
  fixedBrightnessScale() {
    return this.brand === 'samsung' ? 255 : null;
  }

  /**
   * Top of the raw screen_brightness scale: 8191 on the OnePlus 9, 255 on stock
   * Android and Samsung. Starts at 8191: guessing from the current raw value got
   * stuck at 255 after a dark setting. Too high is corrected (the float setting
   * saturates); the learned value is stored. Samsung is fixed at 255: with 8191,
   * 4% was already full brightness there (Galaxy S21+, Tab A9+).
   * ('brightnessRawMax' from an older build is ignored.)
   */
  rawBrightnessMax() {
    return this.fixedBrightnessScale() || this.getStoreValue('brightnessScale') || 8191;
  }

  /**
   * Writes the raw screen_brightness setting: the one method that changes the
   * screen on the OnePlus 9 ('cmd display set-brightness' and the float setting
   * are accepted and ignored there). Works on stock Android too.
   * @param {number} value 0..1
   */
  async setBrightness(value) {
    const target = Math.round(Math.min(1, Math.max(0.01, value)) * 1000) / 1000;
    return this.latest('brightness', target, async (level) => {
      const before = await this.readBrightness();
      if (before.mode === 1) {
        // Adaptive brightness overrides any value we set.
        await this.client.shell('settings put system screen_brightness_mode 0');
        this.log('Adaptive brightness turned off, so the brightness set from Homey stays');
      }
      let max = this.rawBrightnessMax();
      let lastFloat = before.float;
      let saturated = false;
      // Whether this phone mirrors raw into the float setting; only then can a float
      // stuck at 1.0 mean "saturated" instead of "stale".
      let mirrors = this.getStoreValue('brightnessMirrors') === true;
      // Up to 8 rounds: from 8191 down to a 255 scale takes 5 halvings (only once, then stored).
      for (let attempt = 0; attempt < 8; attempt++) {
        const raw = Math.max(1, Math.round(level * max));
        await this.client.shell(`settings put system screen_brightness ${raw}`);
        await delay(400);
        const after = await this.readBrightness();
        this.log(`Brightness ${Math.round(level * 100)}%: raw ${raw} of ${max} -> float now ${after.float}`);
        // When Android mirrors the raw value into the float setting, that shows the
        // real scale. On a phone that doesn't, the float is stale: learn nothing.
        if (after.float !== null && lastFloat !== null && after.float !== lastFloat && !mirrors) {
          mirrors = true;
          await this.setStoreValue('brightnessMirrors', true);
        }
        if (this.fixedBrightnessScale() || !mirrors || after.float === null || after.float < 0.05) break;
        lastFloat = after.float;
        saturated = after.float >= 0.99 && level < 0.97;
        if (after.float >= 0.99 && !saturated) break; // asked for (nearly) full: nothing to learn
        // Saturated: the scale ends below raw. Otherwise raw / float is the scale.
        const measured = saturated ? raw : Math.round(raw / after.float);
        if (Math.abs(measured - max) / max < 0.03 || measured < 100 || measured > 65535) break;
        this.log(`Brightness scale is ${after.float >= 0.99 ? 'at most ' : ''}${measured}, not ${max}: correcting`);
        max = measured;
        await this.setStoreValue('brightnessScale', max);
      }
      await this.setValue('dim', level);
    });
  }

  /** @returns {Promise<{ index: number, max: number } | null>} */
  async readVolume() {
    const match = (await this.client.shell(CMD_VOLUME, { purpose: 'volume' })).match(/volume is (\d+) in range \[(\d+)\.\.(\d+)\]/);
    return match ? { index: Number(match[1]), max: Number(match[3]) } : null;
  }

  /**
   * Like brightness: 'cmd media_session volume --set' is accepted and ignored on
   * the OnePlus 9, while the volume keys work. Try each method and verify.
   * @param {number} value 0..1
   */
  async setVolume(value) {
    const target = Math.round(Math.min(1, Math.max(0, value)) * this.volumeMax);
    return this.latest('volume', target, async (index) => {
      const pressKeys = async () => {
        // A key press moves one step; correct a second time if a phone steps differently.
        for (let round = 0; round < 3; round++) {
          const now = await this.readVolume();
          if (!now || now.index === index) return;
          const key = now.index < index ? 'KEYCODE_VOLUME_UP' : 'KEYCODE_VOLUME_DOWN';
          await this.client.shell(`input keyevent ${Array(Math.abs(index - now.index)).fill(key).join(' ')}`);
          await delay(300);
        }
      };
      const methods = {
        'media_session': () => this.client.shell(`cmd media_session volume --stream 3 --set ${index} 2>&1`),
        'cmd audio': () => this.client.shell(`cmd audio set-volume 3 ${index} 2>&1`),
        'volume keys': pressKeys,
      };
      const order = Object.keys(methods).sort((a, b) => (b === this.volumeMethod) - (a === this.volumeMethod));
      for (const method of order) {
        const output = await methods[method]();
        await delay(300);
        const after = await this.readVolume();
        const ok = after !== null && after.index === index;
        this.log(`Volume ${index}/${this.volumeMax} via ${method}: ${JSON.stringify(output ?? '')} -> now ${after ? after.index : '?'}${ok ? '' : ' (did not stick)'}`);
        if (ok) {
          if (this.volumeMethod !== method) this.log(`Volume: using ${method} from now on`);
          this.volumeMethod = method;
          await this.setValue('volume_set', Math.round((index / this.volumeMax) * 100) / 100);
          return;
        }
      }
      this.error(`Volume: no method worked on this device (wanted ${index})`);
    });
  }

  /** A library error (not paired, unreachable, ...) in the user's language. */
  localizeError(err) {
    return localizeError(this.homey, err, `${this.config.host}:${this.config.port}`);
  }

  async launchApp(packageName) {
    if (!/^[\w.]+$/.test(packageName)) throw new Error(this.homey.__('errors.invalid_app'));
    const output = await this.client.shell(`monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
    if (/No activities found/i.test(output)) throw new Error(this.homey.__('errors.app_not_launchable', { app: packageName }));
  }

  async openUrl(url) {
    url = String(url || '').trim();
    if (!url) throw new Error(this.homey.__('errors.enter_link'));
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    const output = await this.client.shell(`am start -a android.intent.action.VIEW -d ${quote(url)}`);
    if (/Error:/i.test(output)) throw new Error(this.homey.__('errors.cannot_open_link', { url }));
  }

  async pressKey(key) {
    if (!/^KEYCODE_[A-Z0-9_]+$/.test(key)) throw new Error(this.homey.__('errors.invalid_button'));
    await this.client.shell(`input keyevent ${key}`);
    this.pollSoon();
  }

  async typeText(text) {
    // 'input text' wants %s for a space.
    await this.client.shell(`input text ${quote(String(text).replace(/ /g, '%s'))}`);
  }

  /** @returns {Promise<Buffer>} PNG of what is on the screen now */
  async captureScreen() {
    const png = await this.client.exec('screencap -p', { purpose: 'screenshot' });
    if (png.length < 100 || !png.subarray(0, 4).equals(PNG_SIGNATURE)) {
      this.error('Screenshot failed:', png.subarray(0, 200).toString());
      throw new Error(this.homey.__('errors.screenshot_failed'));
    }
    this.screenshot = png;
    this.screenshotTime = Date.now();
    // Only reused for 5 s (see setStream): don't hold several MB after that.
    this.homey.clearTimeout(this.screenshotTimer);
    this.screenshotTimer = this.homey.setTimeout(() => { this.screenshot = null; }, 5000);
    return png;
  }

  /** Takes a screenshot and returns the device's image, for the Flow card's image token. */
  async takeScreenshot() {
    const png = await this.captureScreen();
    this.log(`Screenshot taken (${Math.round(png.length / 1024)} kB)`);
    await this.screenshotImage.update();
    // Only here (button or Flow card), not when Homey merely reloads the image:
    // a Flow that uses the image would otherwise trigger itself.
    await this.fire('screenshot_taken', { image: this.screenshotImage });
    return this.screenshotImage;
  }

  /**
   * There is no ADB command that takes a photo. So: open the camera app, press the
   * shutter with a key event, and fetch the new file from the camera folder.
   * @param {'back'|'front'} camera
   */
  async takePhoto(camera) {
    await this.client.shell(CMD_SCREEN_ON, { purpose: 'photo' });
    await this.client.shell(CMD_DISMISS_KEYGUARD);
    await this.client.shell(`touch ${PHOTO_MARKER}`);
    const focus = "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'";
    const appBefore = parseForegroundApp(await this.client.shell(focus));
    // The facing extras are unofficial; camera apps that don't know them (Samsung) keep their last lens.
    const front = camera === 'front';
    const facing = `--ei android.intent.extras.CAMERA_FACING ${front ? 1 : 0} --ei android.intent.extras.LENS_FACING_FRONT ${front ? 1 : 0} `
      + `--ez android.intent.extra.USE_FRONT_CAMERA ${front} --ez com.google.assistant.extra.USE_FRONT_CAMERA ${front}`;
    const started = await this.client.shell(`am start -a android.media.action.STILL_IMAGE_CAMERA ${facing} 2>&1`);
    await delay(3000); // camera needs a moment before it accepts the shutter
    // The app that came to the front is the camera app; it is stopped again afterwards.
    const cameraApp = parseForegroundApp(await this.client.shell(focus));

    let screen; // last 'wm size' line = override, if any
    const screenSize = async () => {
      if (screen === undefined) {
        const size = [...(await this.client.shell('wm size')).matchAll(/(\d+)x(\d+)/g)].pop();
        screen = size ? { width: Number(size[1]), height: Number(size[2]) } : null;
      }
      return screen;
    };
    // So check which lens is really open, and switch with a vertical swipe over the preview
    // (Samsung's "swipe up/down to switch cameras") when it is the wrong one.
    const openLens = async () => parseOpenCamera(await this.client.shell(CMD_OPEN_CAMERA).catch(() => ''));
    let lens = await openLens();
    if (lens && lens !== camera && await screenSize()) {
      // Positions that are on the screen in portrait and in landscape.
      const short = Math.min(screen.width, screen.height);
      const x = Math.round(short / 2);
      await this.client.shell(`input swipe ${x} ${Math.round(short * 0.35)} ${x} ${Math.round(short * 0.7)} 200`);
      await delay(2000);
      const after = await openLens();
      this.log(`Photo: ${lens} camera was open, swiped to switch -> ${after || 'unknown'}`);
      lens = after;
    }
    this.log(`Photo: ${camera} camera asked, open: ${lens || 'unknown'}`);

    const press = async (method) => {
      if (method !== 'tap') return this.client.shell(`input keyevent ${method}`);
      const size = await screenSize();
      if (!size) return null;
      return this.client.shell(`input tap ${Math.round(size.width / 2)} ${Math.round(size.height * 0.87)}`);
    };
    let found = '';
    let file = null;
    const methods = [...SHUTTER_METHODS].sort((a, b) => (b === this.shutterMethod) - (a === this.shutterMethod));
    try {
      for (const method of methods) {
        await press(method);
        for (let i = 0; i < 8 && !file; i++) {
          await delay(500);
          found = await this.client.shell(CMD_NEW_PHOTOS);
          file = found.split('\n').map((line) => line.trim()).find((line) => /^\/sdcard\/[\w.\- ()/]+\.jpe?g$/i.test(line)) || null;
        }
        this.log(`Photo: shutter ${method} -> ${file || 'no new picture'}`);
        if (file) {
          this.shutterMethod = method;
          break;
        }
      }
      if (!file) {
        // found: new files that are not JPEG (e.g. HEIF), if any.
        this.error(`Photo failed. Camera start: ${JSON.stringify(started)}, new files: ${JSON.stringify(found)}`);
        throw new Error(this.homey.__('errors.photo_failed'));
      }
      // Wait until the camera app finished writing the file.
      let size = -1;
      for (let i = 0; i < 10; i++) {
        const now = Number((await this.client.shell(`stat -c %s ${quote(file)} 2>/dev/null`)).trim());
        if (now > 0 && now === size) break;
        size = now;
        await delay(400);
      }
      const jpeg = await this.client.exec(`cat ${quote(file)}`, { timeout: 60000, purpose: 'photo' });
      if (jpeg.length < 1000 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error(this.homey.__('errors.photo_failed'));
      await fs.promises.writeFile(this.photoFile, jpeg);
      this.log(`Photo taken: ${file} (${Math.round(jpeg.length / 1024)} kB)`);
    } finally {
      await this.client.shell('input keyevent KEYCODE_BACK').catch(this.error); // leave the camera app
      if (cameraApp && cameraApp !== appBefore && /^[\w.]+$/.test(cameraApp)) {
        await this.client.shell(`am force-stop ${cameraApp}`).catch(this.error);
        this.log(`Photo: closed ${cameraApp}`);
      }
      this.pollSoon();
    }
    await this.photoImage.update();
    await this.fire('photo_taken', { image: this.photoImage });
    return this.photoImage;
  }

  /** Wakes the screen, dismisses a swipe lock and opens a link or an app. */
  async showOnScreen({ url, app }) {
    await this.client.shell(CMD_SCREEN_ON);
    await this.client.shell(CMD_DISMISS_KEYGUARD);
    if (url !== undefined) await this.openUrl(url);
    else await this.launchApp(app);
    this.pollSoon();
  }

  async closeApp(packageName) {
    if (!/^[\w.]+$/.test(packageName)) throw new Error(this.homey.__('errors.invalid_app'));
    await this.client.shell(`am force-stop ${packageName}`);
    this.pollSoon();
  }

  /** Taps (2 numbers) or swipes (4 numbers) at pixel positions. */
  async touch(...positions) {
    const numbers = positions.map((value) => Math.round(Number(value)));
    if (numbers.some((value) => !Number.isFinite(value) || value < 0 || value > 20000)) {
      throw new Error(this.homey.__('errors.invalid_position'));
    }
    await this.client.shell(numbers.length === 2 ? `input tap ${numbers.join(' ')}` : `input swipe ${numbers.join(' ')} 300`);
    this.pollSoon();
  }

  /**
   * Ringtone, notification or alarm volume. No key presses to fall back on here.
   * @param {'ring'|'notification'|'alarm'} stream
   * @param {number} percent 0..100
   */
  async setStreamVolume(stream, percent) {
    const id = VOLUME_STREAMS[stream];
    const read = async () => {
      const output = await this.client.shell(`cmd media_session volume --stream ${id} --get 2>/dev/null || media volume --stream ${id} --get 2>/dev/null`);
      const match = output.match(/volume is (\d+) in range \[(\d+)\.\.(\d+)\]/);
      return match ? { index: Number(match[1]), max: Number(match[3]) } : null;
    };
    const before = id ? await read() : null;
    if (!before) throw new Error(this.homey.__('errors.volume_failed'));
    const index = Math.round((Math.min(100, Math.max(0, Number(percent) || 0)) / 100) * before.max);
    for (const command of [`cmd media_session volume --stream ${id} --set ${index}`, `cmd audio set-volume ${id} ${index}`]) {
      const output = await this.client.shell(`${command} 2>&1`);
      await delay(300);
      const after = await read();
      this.log(`${stream} volume ${index}/${before.max} via ${command}: ${JSON.stringify(output)} -> now ${after ? after.index : '?'}`);
      if (after && after.index === index) return;
    }
    throw new Error(this.homey.__('errors.volume_failed'));
  }

  /** Fires a device trigger; never lets a Flow problem break the state check. */
  async fire(id, tokens) {
    await this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens, {}).catch(this.error);
  }

  /** Reads Bluetooth from the setting Android's Bluetooth service keeps up to date. */
  async readBluetooth() {
    const output = await this.client.shell('settings get global bluetooth_on', { purpose: 'bluetooth' });
    return /^1/.test(output.trim()) ? true : /^0/.test(output.trim()) ? false : null;
  }

  /** @param {boolean} on */
  async setBluetooth(on) {
    const word = on ? 'enable' : 'disable';
    // Android 12+ has 'cmd bluetooth_manager'; 'svc bluetooth' is the older way.
    for (const command of [`cmd bluetooth_manager ${word}`, `svc bluetooth ${word}`]) {
      const output = await this.client.shell(`${command} 2>&1`);
      let now = null;
      for (let i = 0; i < 6 && now !== on; i++) { // switching takes a moment
        await delay(500);
        now = await this.readBluetooth();
      }
      this.log(`Bluetooth ${on ? 'on' : 'off'} via ${command}: ${JSON.stringify(output)} -> now ${now}`);
      if (now === on) {
        await this.updateBluetooth(on);
        return;
      }
    }
    throw new Error(this.homey.__('errors.bluetooth_failed'));
  }

  /** Remembers the Bluetooth state; fires the triggers when it changed. */
  async updateBluetooth(on) {
    const before = this.bluetoothOn;
    this.bluetoothOn = on;
    await this.setValue('bluetooth_enabled', on);
    // Not on the first reading after start: that is no change.
    if (before === undefined || before === null || before === on) return;
    this.log(`Bluetooth turned ${on ? 'on' : 'off'}`);
    await this.fire(on ? 'bluetooth_turned_on' : 'bluetooth_turned_off', {});
  }

  /** @param {'off'|'priority'|'alarms'|'none'} mode */
  async setDoNotDisturb(mode) {
    const ZEN = { off: '0', priority: '1', none: '2', alarms: '3' }; // settings global zen_mode
    if (!(mode in ZEN)) throw new Error(this.homey.__('errors.dnd_failed'));
    const output = await this.client.shell(`cmd notification set_dnd ${mode} 2>&1`);
    await delay(300);
    const now = (await this.client.shell('settings get global zen_mode')).trim();
    this.log(`Do Not Disturb ${mode}: ${JSON.stringify(output)} -> zen_mode ${now}`);
    if (now !== ZEN[mode]) throw new Error(this.homey.__('errors.dnd_failed'));
    await this.setValue('dnd_mode', this.homey.__(`dnd.${mode}`));
  }

  /** @param {boolean} on */
  async setAutoRotate(on) {
    await this.client.shell(`settings put system accelerometer_rotation ${on ? 1 : 0}`);
    this.log(`Auto-rotate ${on ? 'on' : 'off'}`);
    await this.setValue('auto_rotate', on);
  }

  /** Posts a notification from the Shell app. Each gets its own tag, so they stack. */
  async showNotification(title, text) {
    title = String(title || '').trim();
    text = String(text || '').trim() || title;
    if (!text) throw new Error(this.homey.__('errors.enter_text'));
    const tag = `homey-${Date.now()}`;
    const args = title ? `-S bigtext -t ${quote(title)} ` : '-S bigtext ';
    const output = await this.client.shell(`cmd notification post ${args}${tag} ${quote(text)} 2>&1`);
    this.log(`Notification ${JSON.stringify(title)}: ${JSON.stringify(output)}`);
    if (/exception|unknown|error/i.test(output)) throw new Error(output.split('\n')[0]);
  }

  /** Restarts the device. Wireless debugging is off afterwards until turned on again. */
  async reboot() {
    this.log('Restarting the device');
    await this.client.reboot();
    this.pollSoon();
  }

  async setStayAwake(enabled) {
    await this.client.shell(`svc power stayon ${enabled ? 'true' : 'false'}`);
  }

  async setScreenTimeout(seconds) {
    const ms = Math.round(Number(seconds) * 1000);
    if (!(ms >= 1000)) throw new Error(this.homey.__('errors.invalid_timeout'));
    await this.client.shell(`settings put system screen_off_timeout ${ms}`);
  }

  /** Package names on the device matching the search text. Cached for a minute. */
  async listApps(query = '') {
    if (!this.appsCache || Date.now() - this.appsCacheTime > 60000) {
      const all = (await this.client.shell('pm list packages'))
        .split('\n').map((line) => line.replace(/^package:/, '').trim()).filter(Boolean);
      const user = new Set((await this.client.shell('pm list packages -3').catch(() => ''))
        .split('\n').map((line) => line.replace(/^package:/, '').trim()));
      // Apps the user installed first, system apps after that.
      this.appsCache = all.sort((a, b) => (user.has(b) - user.has(a)) || a.localeCompare(b));
      this.appsCacheTime = Date.now();
    }
    const needle = query.toLowerCase();
    // Search matches the package name and the readable name.
    return this.appsCache
      .map((id) => ({ id, name: appName(id), description: id }))
      .filter((item) => item.id.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle))
      .slice(0, 40);
  }

  async getForegroundApp() {
    const app = parseForegroundApp(await this.client.shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"));
    if (app) await this.updateForegroundApp(app);
    return app;
  }

  /** Shows the app's name on the sensor tab; fires the trigger when another app came to the front. */
  async updateForegroundApp(packageName) {
    const before = this.foregroundPackage;
    this.foregroundPackage = packageName;
    await this.setValue('foreground_app', appName(packageName));
    if (before && before !== packageName) {
      this.log(`App on screen: ${packageName}`);
      await this.fire('foreground_app_changed', { name: appName(packageName), package: packageName });
    }
  }

  async runShell(command) {
    const output = await this.client.shell(command);
    this.log(`Shell: ${command} -> ${JSON.stringify(output.length > 2000 ? `${output.slice(0, 2000)}...` : output)}`);
    await this.shellToken.setValue(output).catch(this.error);
    return output;
  }

  /** Logs state lines that could not be parsed, once per distinct output. */
  logUnparsed(what, lines) {
    this.unparsedLogged = this.unparsedLogged || {};
    if (this.unparsedLogged[what] === lines) return;
    this.unparsedLogged[what] = lines;
    this.log(`Could not read ${what} from: ${JSON.stringify(lines)}`);
  }

  /* ----- Wireless debugging: follow the device when its random port changes ----- */

  onDiscoveryResult(discoveryResult) {
    const serial = this.getData().id;
    return (discoveryResult.name || '').includes(serial)
      || discoveryResult.address === this.config.host;
  }

  async onDiscoveryAvailable(discoveryResult) {
    await this.applyDiscovery(discoveryResult);
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.applyDiscovery(discoveryResult).catch(this.error);
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.applyDiscovery(discoveryResult).catch(this.error);
  }

  async applyDiscovery({ address, port }, { recheck = true } = {}) {
    const settings = this.config;
    // Classic network ADB on 5555 is a fixed port: leave it alone.
    if (Number(settings.port) === 5555 || !address || !port) return;
    if (settings.host === address && Number(settings.port) === Number(port)) {
      // Same address, but the device just showed up again (Wireless debugging
      // was turned back on): don't wait for the next retry.
      if (recheck && this.lastError && Date.now() - (this.lastDiscoveryPoll || 0) > 10000) {
        this.lastDiscoveryPoll = Date.now();
        this.poll().catch(this.error);
      }
      return;
    }
    this.log(`Device announced a new address: ${address}:${port}`);
    await this.useAddress(address, Number(port));
  }

  /** Fallback for when the announcement was missed: ask the discovery cache. */
  async refreshFromDiscovery() {
    const results = Object.values(this.driver.getDiscoveryStrategy().getDiscoveryResults());
    const match = results.find((result) => this.onDiscoveryResult(result));
    if (match) await this.applyDiscovery(match, { recheck: false });
  }

  async useAddress(host, port) {
    await this.setSettings({ host, port });
    this.config = { ...this.config, host, port };
    this.createClient({ host, port });
    // Not awaited: this can be called from inside a running check.
    this.poll().catch(this.error);
  }

  /* ----- State ----- */

  async setValue(capability, value) {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    if (this.getCapabilityValue(capability) !== value) {
      await this.setCapabilityValue(capability, value);
    }
  }

  /** Reads the real state, so manual use of the device shows up in Homey too. */
  poll() {
    // One check at a time. A request that arrives while one is running makes
    // it run once more afterwards (the address may have changed meanwhile).
    if (this.pollPromise) {
      this.pollAgain = true;
      return this.pollPromise;
    }
    this.pollPromise = (async () => {
      do {
        this.pollAgain = false;
        await this.pollNow();
      } while (this.pollAgain);
    })().finally(() => {
      this.pollPromise = null;
      this.scheduleNextPoll();
    });
    return this.pollPromise;
  }

  async pollNow() {
    try {
      const output = await this.client.shell(CMD_STATE, { purpose: 'state check' });
      await this.applyState(output);
      if (this.lastError || !this.getAvailable()) {
        this.log('Connected');
        this.lastError = null;
        await this.setAvailable();
      }
    } catch (err) {
      // Log each distinct problem once instead of on every poll.
      if (this.lastError !== err.message) this.error('ADB error:', err.message);
      const firstFailure = !this.lastError;
      this.lastError = err.message;
      await this.setUnavailable(this.localizeError(err).message);
      // Maybe the Wireless debugging port changed (it does whenever it is toggled).
      if (firstFailure) await this.refreshFromDiscovery().catch(this.error);
    }
  }

  async applyState(output) {
    // Screen: Awake = on. Asleep / Dozing / Dreaming count as off.
    const wake = output.match(/mWakefulness=(\w+)/);
    if (wake) {
      const on = wake[1] === 'Awake';
      if (this.getCapabilityValue('onoff') !== on) this.log(`Screen is ${wake[1]}`);
      await this.setValue('onoff', on);
    } else {
      this.error('Unexpected state output:', output);
    }

    // Battery. status: 2 = charging, 3 = discharging, 4 = not charging, 5 = full
    const level = output.match(/^\s*level:\s*(\d+)/m);
    if (level) await this.setValue('measure_battery', Math.min(100, Number(level[1])));
    const status = output.match(/^\s*status:\s*(\d+)/m);
    this.pluggedIn = /powered:\s*true/.test(output);
    if (status) {
      let state = 'discharging';
      if (status[1] === '2') state = 'charging';
      else if (this.pluggedIn) state = 'idle';
      await this.setValue('battery_charging_state', state);
    }

    // Brightness 0..1 from the raw setting, the one that really drives the screen
    // (see setBrightness). Scale per phone; the float setting only as a fallback.
    this.noteBrand(output);
    const raw = output.match(/^brightness_raw=(\d+)\s*$/m);
    const float = output.match(/^brightness_float=([\d.]+)\s*$/m);
    if (raw) await this.setValue('dim', Math.min(1, Math.round((Number(raw[1]) / this.rawBrightnessMax()) * 100) / 100));
    else if (float) await this.setValue('dim', Math.min(1, Number(float[1])));
    else this.logUnparsed('brightness', output.split('\n').filter((l) => /^brightness/.test(l)).join('\n'));

    // Battery temperature in tenths of a degree, e.g. "temperature: 312".
    const temperature = output.match(/^\s*temperature:\s*(\d+)/m);
    if (temperature) await this.setValue('measure_temperature', Number(temperature[1]) / 10);

    const bluetooth = output.match(/^bluetooth=(\d)/m);
    if (bluetooth) await this.updateBluetooth(bluetooth[1] === '1');

    const rotation = output.match(/^rotation=(\d)/m);
    if (rotation) await this.setValue('auto_rotate', rotation[1] === '1');
    const zen = output.match(/^zen=(\d)/m);
    if (zen && DND_MODES[zen[1]]) await this.setValue('dnd_mode', this.homey.__(`dnd.${DND_MODES[zen[1]]}`));

    // Wi-Fi the device is on. Android reports "<unknown ssid>" when it won't tell.
    const wifi = (output.match(/^wifi=(.*)$/m) || [])[1] || '';
    const ssid = wifi.match(/SSID: "([^"]*)"/);
    const rssi = wifi.match(/RSSI: (-?\d+)/);
    if (ssid) {
      const before = this.getCapabilityValue('wifi_network');
      await this.setValue('wifi_network', ssid[1]);
      if (this.stateSeen && before !== ssid[1]) await this.fire('wifi_network_changed', { network: ssid[1] });
    }
    if (rssi && Number(rssi[1]) < 0 && Number(rssi[1]) > -127) await this.setValue('measure_signal_strength', Number(rssi[1]));
    if (!ssid && !rssi) this.logUnparsed('Wi-Fi', wifi);

    const app = parseForegroundApp(output);
    if (app) await this.updateForegroundApp(app);

    const timeout = output.match(/^timeout=(\d+)/m);
    if (timeout) await this.setValue('screen_timeout', Math.round(Number(timeout[1]) / 1000));
    const stayOn = output.match(/^stayon=(\d+)/m); // bit mask of power sources, 0 = off
    if (stayOn) await this.setValue('stay_awake', Number(stayOn[1]) > 0);
    // df -k: Filesystem 1K-blocks Used Available Use% Mounted
    const storage = output.match(/^storage=\S+\s+\d+\s+\d+\s+(\d+)\s/m);
    if (storage) await this.setValue('storage_free', Math.round(Number(storage[1]) / 1024 / 102.4) / 10);

    const media = parseMedia(output);
    await this.setValue('speaker_playing', media ? media.playing : false);
    if (media && media.track !== undefined) {
      await this.setValue('speaker_track', media.track);
      await this.setValue('speaker_artist', media.artist);
      await this.setValue('speaker_album', media.album);
    }
    this.stateSeen = true; // from now on, differences are real changes

    // Media volume, e.g. "volume is 7 in range [0..15]"
    const volume = output.match(/volume is (\d+) in range \[(\d+)\.\.(\d+)\]/);
    if (volume && Number(volume[3]) > 0) {
      this.volumeMax = Number(volume[3]);
      await this.setValue('volume_set', Math.round((Number(volume[1]) / this.volumeMax) * 100) / 100);
    } else {
      const known = /mWakefulness=|^\s*(level|status|powered|AC powered|USB powered|Wireless powered|Dock powered):|^brightness|^brand=/;
      this.logUnparsed('volume', output.split('\n').filter((l) => !known.test(l)).join('\n'));
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    this.config = { ...newSettings };
    if (changedKeys.includes('host') || changedKeys.includes('port')) {
      this.createClient(this.config);
    } else {
      this.client.setIdleTimeout(this.config.keep_alive === false ? IDLE_DISCONNECT_MS : 0);
    }
    this.pollSoon();
  }

  async onUninit() {
    for (const token of [this.shellToken]) {
      if (token) await this.homey.flow.unregisterToken(token).catch(this.error);
    }
    this.homey.clearTimeout(this.pollTimer);
    this.homey.clearTimeout(this.screenshotTimer);
    this.screenshot = null;
    if (this.client) await this.client.disconnect();
  }

  async onDeleted() {
    await this.onUninit();
    if (this.photoFile) await fs.promises.unlink(this.photoFile).catch(() => {});
  }

}

module.exports = TabletDevice;
