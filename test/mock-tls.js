'use strict';

let lastPairedName = null;
const LANGUAGES = ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'ru', 'pl', 'ko', 'ar'];
// Fake Android 11+ device: pairing server (SPAKE2) + adbd on a TLS "Wireless debugging" port.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const AdbClient = require('../lib/AdbClient');
const CredentialStore = require('../lib/CredentialStore');
const Spake2 = require('../lib/Spake2');
const { createTlsCredentials } = require('../lib/Certificate');
const { pair, _internal: P } = require('../lib/AdbPairing');

const CMD = { CNXN: 0x4e584e43, STLS: 0x534c5453, OPEN: 0x4e45504f, OKAY: 0x59414b4f, WRTE: 0x45545257, CLSE: 0x45534c43 };
function pkt(cmd, a0, a1, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(24);
  h.writeUInt32LE(cmd, 0); h.writeUInt32LE(a0, 4); h.writeUInt32LE(a1, 8); h.writeUInt32LE(payload.length, 12);
  h.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, payload]);
}
const deviceKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'der', type: 'pkcs8' });
const deviceTls = createTlsCredentials(deviceKey);
const CODE = '482913';
const pairedModuli = new Set(); // hex modulus of paired ADB keys

// adb public key struct: u32 len(words), u32 n0inv, u8[256] modulus LE, u8[256] rr, u32 exponent
function modulusFromAdbKey(line) {
  const raw = Buffer.from(line.split(' ')[0], 'base64');
  if (raw.length !== 524) throw new Error('bad adb key size ' + raw.length);
  return Buffer.from(raw.subarray(8, 264)).reverse().toString('hex');
}
function modulusFromCert(cert) {
  const jwk = new crypto.X509Certificate(cert.raw).publicKey.export({ format: 'jwk' });
  return Buffer.from(jwk.n, 'base64url').toString('hex');
}

const pairingServer = tls.createServer({ ...deviceTls, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, async (s) => {
  s.on('error', () => {});
  try {
    const reader = new P.SocketReader(s);
    const ekm = s.exportKeyingMaterial(P.EXPORTED_KEY_SIZE, P.EXPORTED_KEY_LABEL);
    const spake = new Spake2('bob', P.SERVER_NAME, P.CLIENT_NAME);
    const myMsg = await spake.generateMessage(Buffer.concat([Buffer.from(CODE), ekm]));
    const theirMsg = await P.readPacket(reader, P.TYPE_SPAKE2_MSG);
    s.write(P.packet(P.TYPE_SPAKE2_MSG, myMsg));
    const key = Buffer.from(crypto.hkdfSync('sha256', spake.processMessage(theirMsg), Buffer.alloc(0), P.HKDF_INFO, 16));
    const info = P.decrypt(key, 0, await P.readPacket(reader, P.TYPE_PEER_INFO)); // throws on wrong code
    if (info.length !== P.PEER_INFO_SIZE || info[0] !== 0) throw new Error('bad peer info');
    const line = info.subarray(1, info.indexOf(0, 1)).toString();
    pairedModuli.add(modulusFromAdbKey(line));
    // Like Android: the shown name is what follows the key, split on whitespace.
    lastPairedName = line.split(/\s+/)[1];
    console.log('[device] paired key:', line.slice(0, 12) + '...', lastPairedName);
    const mine = Buffer.alloc(P.PEER_INFO_SIZE); mine[0] = 1; mine.write('adb-MOCKSERIAL-guid', 1);
    s.write(P.packet(P.TYPE_PEER_INFO, P.encrypt(key, 0, mine)));
  } catch (e) { console.log('[device] pairing rejected:', e.message); s.destroy(); }
});

let wake = 'Asleep'; let vol = 9;
let bluetooth = 0; let zen = 0; let rotation = 1; let notifications = []; let rebooted = 0; const triggered = [];
let front = 'com.spotify.music'; let playing = true; let wifiName = 'Home Wi-Fi'; const ran = []; const otherVolumes = { 2: 5, 4: 7, 5: 5 };
const triggerTokens = {}; const flowTokens = {};
// A 1x1 PNG, as 'screencap -p' output.
const SCREEN_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg' + 'A'.repeat(120) + '==', 'base64');
let brightRaw = 2048; let BRIGHT_MAX = 8191; // raw brightness scale of the OnePlus 9
let brightMode = '1'; // adaptive brightness on, like most phones
const adbd = net.createServer((plain) => {
  let s = plain; let buf = Buffer.alloc(0); let lid = 100; let secure = false;
  const banner = Buffer.from('device::ro.product.name=mock;ro.product.model=OnePlus9;features=cmd,shell_v2');
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 24) {
      const len = buf.readUInt32LE(12); if (buf.length < 24 + len) return;
      const cmd = buf.readUInt32LE(0), a0 = buf.readUInt32LE(4);
      const payload = buf.subarray(24, 24 + len); buf = buf.subarray(24 + len);
      if (cmd === CMD.CNXN && !secure) s.write(pkt(CMD.STLS, 0x01000000, 0));
      else if (cmd === CMD.STLS) {
        // The client's TLS hello may already sit in our buffer (real adbd reads exact
        // packet sizes, this mock doesn't), so feed TLS through a proxy stream.
        plain.removeListener('data', onData);
        const proxy = new (require('node:stream').Duplex)({ read() {}, write(c, e, cb) { plain.write(c, cb); } });
        proxy.push(buf); buf = Buffer.alloc(0);
        plain.on('data', (c) => proxy.push(c)); plain.on('close', () => proxy.destroy());
        const t = new tls.TLSSocket(proxy, { isServer: true, secureContext: tls.createSecureContext({ ...deviceTls, minVersion: 'TLSv1.3' }), requestCert: true, rejectUnauthorized: false });
        t.on('error', () => {});
        t.on('secure', () => {
          const cert = t.getPeerCertificate(true);
          if (!cert || !cert.raw || !pairedModuli.has(modulusFromCert(cert))) { console.log('[device] unknown client key, kicking'); t.destroy(); plain.destroy(); return; }
          secure = true; s = t; t.on('data', onData); t.write(pkt(CMD.CNXN, 0x01000001, 1024 * 1024, banner));
        });
        return;
      } else if (cmd === CMD.OPEN && secure) {
        const svc = payload.toString().replace(/\0$/, ''); const id = lid++; let out = '';
        if (svc === 'reboot:') { rebooted++; s.destroy(); plain.destroy(); return; } // adbd's reboot service: the whole connection drops
        const single = !svc.includes('mWakefulness');
        const other = svc.match(/volume --stream ([245]) --(get|set)(?: (\d+))?/); // ring, alarm, notification
        if (svc.includes('screencap -p')) out = SCREEN_PNG;
        else if (other && svc.startsWith('exec:cmd media_session volume') && other[2] === 'set') otherVolumes[other[1]] = Number(other[3]); // assumed: works for these streams
        else if (other) out = `[V] volume is ${otherVolumes[other[1]]} in range [0..7]\n`;
        else if (svc.includes('am force-stop ') || svc.includes('input tap ') || svc.includes('input swipe ')) ran.push(svc.replace(/^exec:/, ''));
        else if (svc.includes('KEYCODE_MEDIA_PLAY')) playing = true;
        else if (svc.includes('KEYCODE_MEDIA_PAUSE')) playing = false;
        else if (single && svc.includes('cmd bluetooth_manager ')) bluetooth = svc.includes('enable') ? 1 : 0;
        else if (single && svc.includes('settings get global bluetooth_on')) out = `${bluetooth}\n`;
        else if (single && svc.includes('cmd notification set_dnd ')) zen = { off: 0, priority: 1, none: 2, alarms: 3 }[svc.match(/set_dnd (\w+)/)[1]];
        else if (single && svc.includes('settings get global zen_mode')) out = `${zen}\n`;
        else if (single && svc.includes('put system accelerometer_rotation')) rotation = Number(svc.match(/accelerometer_rotation (\d)/)[1]);
        else if (svc.includes('cmd notification post')) { notifications.push(svc); out = 'Notification posted\n'; }
        else if (svc.includes('KEYCODE_WAKEUP')) wake = 'Awake';
        else if (svc.includes('KEYCODE_SLEEP')) wake = 'Asleep';
        // Like the real OnePlus 9: 'cmd display set-brightness', the float setting and
        // 'media_session --set' are accepted and ignored; the raw setting (capped at 8191)
        // and the volume keys work. Assumed: Android mirrors raw into the float setting.
        else if (svc.includes('set-brightness') || svc.includes('put system screen_brightness_float')) out = '';
        else if (svc.includes('put system screen_brightness ')) brightRaw = Number(svc.match(/screen_brightness (\d+)/)[1]); // stored as is, the screen saturates
        else if (svc.includes('put system screen_brightness_mode')) brightMode = svc.match(/screen_brightness_mode (\d)/)[1];
        else if (svc.includes('echo mode=')) out = `mode=${brightMode}\nfloat=${Math.min(1, brightRaw / BRIGHT_MAX).toFixed(4)}\nraw=${brightRaw}\n`;
        else if (svc.includes('media_session volume --stream 3 --set')) out = '[V] will control stream=3 (STREAM_MUSIC)\n[V] will set volume to index=x\n[V] Connecting to AudioService\n';
        else if (svc.includes('cmd audio set-volume')) out = "Unknown command: set-volume\n";
        else if (svc.includes('KEYCODE_VOLUME_')) {
          vol += (svc.match(/KEYCODE_VOLUME_UP/g) || []).length - (svc.match(/KEYCODE_VOLUME_DOWN/g) || []).length;
          vol = Math.max(0, Math.min(30, vol));
        } else if (svc.includes('media_session volume --stream 3 --get') && !svc.includes('mWakefulness')) out = `[V] will get volume\n[V] volume is ${vol} in range [0..30]\n`;
        else if (svc.includes('mWakefulness')) out = `  mWakefulness=${wake}\n  AC powered: true\n  USB powered: false\n  status: 2\n  level: 87\n  temperature: 312\nbluetooth=${bluetooth}\nrotation=${rotation}\nzen=${zen}\nwifi=WifiInfo: SSID: "${wifiName}", BSSID: 02:00:00:00:00:00, MAC: 02:00:00:00:00:00, RSSI: -55, Link speed: 866Mbps\n  mCurrentFocus=Window{a1b2 u0 ${front}/${front}.MainActivity}\ntimeout=30000\nstayon=3\nstorage=/dev/block/dm-48 111762240 61762240 50000000 56% /data\n      state=PlaybackState {state=${playing ? 'PLAYING(3)' : 'PAUSED(2)'}, position=1000, buffered position=0, speed=1.0}\n      metadata: size=12, description=Hello, Goodbye, The Beatles, Magical Mystery Tour\nbrightness_float=${Math.min(1, brightRaw / BRIGHT_MAX).toFixed(4)}\nbrightness_raw=${brightRaw}\n[V] will get volume\n[V] volume is ${vol} in range [0..30]\n`;
        else if (svc.includes('pm list packages -3')) out = 'package:com.spotify.music\n';
        else if (svc.includes('pm list packages')) out = 'package:com.android.chrome\npackage:com.spotify.music\npackage:com.android.settings\n';
        else if (svc.includes('dumpsys window')) out = `  mCurrentFocus=Window{a1b2 u0 ${front}/${front}.MainActivity}\n`;
        if (!svc.includes('dumpsys') && !svc.includes('getprop')) console.log('   [device ran]', svc.replace(/^exec:/, ''));
        else if (svc.includes('big')) out = 'x'.repeat(200000);
        s.write(pkt(CMD.OKAY, id, a0));
        for (let i = 0; i < out.length; i += 60000) s.write(pkt(CMD.WRTE, id, a0, Buffer.from(out.slice(i, i + 60000))));
        s.write(pkt(CMD.CLSE, id, a0));
      }
    }
  };
  plain.on('data', onData); plain.on('error', () => {});
});

const settings = new Map();
const homey = { settings: { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) } };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
  const pairPort = await listen(pairingServer); const port = await listen(adbd);
  const store = new CredentialStore(homey);
  const client = () => new AdbClient({ host: '127.0.0.1', port, credentialStore: store });

  await client().shell('x').catch((e) => console.log('1. not paired yet ->', e.message));

  const key = await store.getOrCreateKey();
  const publicKey = await AdbClient.getAdbPublicKey(key);
  await pair({ host: '127.0.0.1', port: pairPort, code: '000000', privateKey: key.buffer, publicKey })
    .catch((e) => console.log('2. wrong code ->', e.message));
  console.log('3. right code ->', await pair({ host: '127.0.0.1', port: pairPort, code: CODE, privateKey: key.buffer, publicKey }));

  const c = client();
  await c.connect();
  console.log('4. connected, secure =', c.secure, c.socket.getProtocol(), 'model =', c.adb.banner.model);
  console.log('   state:', await c.shell('dumpsys power | grep mWakefulness='));
  await c.shell('input keyevent KEYCODE_WAKEUP');
  console.log('   state:', await c.shell('dumpsys power | grep mWakefulness='));
  console.log('   large output bytes:', (await c.shell('big')).length);
  const gone = new Promise((r) => c.once('disconnect', r));
  c.socket.destroy(); await gone;
  await c.shell('input keyevent KEYCODE_SLEEP');
  console.log('5. reconnected, state:', await c.shell('dumpsys power | grep mWakefulness='), 'secure =', c.secure);
  await c.disconnect();

  // Driver + device classes with a stubbed Homey SDK
  const Module = require('node:module'); const origLoad = Module._load;
  class Base { log(...a) { console.log('   [log]', ...a); } error(...a) { console.log('   [err]', ...a); } }
  class Device extends Base {
    constructor() { super(); this.error = this.error.bind(this); this.caps = {}; this.available = true; }
    getSettings() { return this.settings; } getSetting(k) { return this.settings[k]; }
    async setSettings(v) { Object.assign(this.settings, v); }
    getStoreValue(k) { return (this.store || {})[k]; } async setStoreValue(k, v) { this.store = { ...this.store, [k]: v }; }
    getData() { return { id: 'MOCKSERIAL' }; } registerCapabilityListener(n, fn) { this.listeners = this.listeners || {}; this.listeners[n] = fn; if (n === 'onoff') this.listener = fn; }
    getCapabilityValue(k) { return this.caps[k]; } hasCapability(k) { return k === 'onoff'; } async addCapability(k) { this.added = (this.added || []).concat(k); } async setCapabilityValue(k, v) { this.caps[k] = v; }
    getAvailable() { return this.available; } async setAvailable() { this.available = true; }
    async setUnavailable(m) { this.available = false; this.reason = m; }
    async setCameraImage(id, title, image) { this.camera = { id, title, image }; }
    getName() { return 'OnePlus 9'; }
  }
  Module._load = (req, ...rest) => (req === 'homey' ? { Driver: Base, Device, App: Base } : origLoad(req, ...rest));
  const timers = { setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {} };
  // Like homey.__(): key path into /locales/en.json, __token__ replaced.
  const en = require('../locales/en.json');
  const __ = (key, tokens = {}) => key.split('.').reduce((o, k) => o[k], en).replace(/__(\w+)__/g, (m, k) => tokens[k]);
  const homey2 = { ...homey, ...timers, __, images: { createImage: async () => ({ setStream(fn) { this.fn = fn; }, async update() { this.updated = (this.updated || 0) + 1; } }) }, flow: { getActionCard: () => card(), getConditionCard: () => card(), createToken: async (id, opts) => { const token = { id, opts, async setValue(v) { this.value = v; } }; flowTokens[id] = token; return token; }, unregisterToken: async (token) => { delete flowTokens[token.id]; }, getDeviceTriggerCard: (id) => ({ trigger: async (dev, tokens) => { triggered.push(id); triggerTokens[id] = tokens; } }) } };
  function card() { const c = { registerRunListener() { return c; }, registerArgumentAutocompleteListener() { return c; } }; return c; }
  settings.clear(); pairedModuli.clear();
  const driver = new (require('../drivers/tablet/driver.js'))(); driver.homey = homey2;
  let announced = {};
  driver.getDevices = () => [];
  driver.getDiscoveryStrategy = () => ({ getDiscoveryResults: () => announced });
  await driver.onInit();
  console.log('6. driver connect without code ->', await driver.connectDevice({ host: '127.0.0.1', port }).catch((e) => e.message.slice(0, 40)));
  console.log('7. driver connect with code ->', await driver.connectDevice({ host: '127.0.0.1', port, pairingPort: pairPort, pairingCode: ' 482 913 ' }));
  console.log('   name shown on the device:', lastPairedName);
  if (lastPairedName !== 'Homey') throw new Error(`key name: expected "Homey", got ${lastPairedName}`);
  const device = new (require('../drivers/tablet/device.js'))(); device.homey = homey2; device.driver = driver;
  device.settings = { host: '127.0.0.1', port: 9, poll_interval: 15, dismiss_keyguard: false }; // stale port
  announced = { x: { name: 'adb-MOCKSERIAL-abc123', address: '127.0.0.1', port } };
  await device.onInit(); await device.poll();
  console.log('8. device followed announced port:', device.settings.port === port, 'available =', device.available, 'onoff =', device.caps.onoff);
  await device.listener(true); await device.poll();
  console.log('9. after turning on: onoff =', device.caps.onoff);
  console.log('10. migrated caps:', device.added.join(','), '| state:', JSON.stringify(device.caps), 'volumeMax =', device.volumeMax, 'pluggedIn =', device.pluggedIn);
  await device.listeners.dim(0.6); await device.listeners.volume_set(0.5); await device.poll();
  console.log('11. after set: dim =', device.caps.dim, 'volume =', device.caps.volume_set,
    '| on the device: raw brightness', brightRaw, 'volume', vol, 'adaptive', brightMode, '| volume method:', device.volumeMethod);
  if (brightRaw !== 4915 || vol !== 15 || brightMode !== '0') throw new Error('brightness/volume did not reach the device');
  if (device.volumeMethod !== 'volume keys') throw new Error('wrong volume fallback chosen');
  await Promise.all([device.listeners.dim(0.2), device.listeners.dim(0.3), device.listeners.dim(0.4)]);
  await device.listeners.volume_set(0.2);
  console.log('    again (remembered method, dragged slider): raw brightness', brightRaw, 'volume', vol);
  if (brightRaw !== 3276 || vol !== 6) throw new Error('second set failed');
  BRIGHT_MAX = 2047; brightRaw = 1000; device.store = {}; device.latestRuns = {}; // a phone with another scale
  await device.listeners.dim(0.5); await device.poll();
  console.log('    other scale: learned max', device.getStoreValue('brightnessScale'), '| raw', brightRaw, '| slider', device.caps.dim);
  if (Math.abs(device.getStoreValue('brightnessScale') - 2047) > 20 || brightRaw !== 1024 || device.caps.dim !== 0.5) throw new Error('scale not learned');
  BRIGHT_MAX = 255; brightRaw = 40; device.store = {}; device.latestRuns = {}; // stock Android scale, starting dark
  await device.listeners.dim(1); await device.listeners.dim(0.5); await device.poll();
  console.log('    255 phone starting dark: learned', device.getStoreValue('brightnessScale'), '| raw', brightRaw, '| slider', device.caps.dim);
  if (Math.abs(device.getStoreValue('brightnessScale') - 255) > 3 || Math.abs(brightRaw - 128) > 2) throw new Error('255 scale not learned');
  BRIGHT_MAX = 8191; brightRaw = 100; device.store = {}; device.latestRuns = {}; // OnePlus, starting dark: must still use 8191
  await device.listeners.dim(1);
  console.log('    OnePlus starting dark, 100% -> raw', brightRaw);
  if (brightRaw !== 8191) throw new Error('OnePlus stuck below full brightness');
  BRIGHT_MAX = 8191; brightRaw = 2048; device.store = {}; device.latestRuns = {};
  console.log('12. apps "o":', (await device.listApps('o')).map((a) => a.id).join(','), '| foreground:', await device.getForegroundApp());
  await device.launchApp('com.spotify.music'); await device.openUrl("my.homey.app/it's?a=1&b=2"); await device.typeText("it's me"); await device.pressKey('KEYCODE_HOME'); await device.setStayAwake(true); await device.setScreenTimeout(60);
  console.log('13. bad input rejected:', await device.launchApp('x; reboot').catch((e) => e.message), '/', await device.pressKey('1; reboot').catch((e) => e.message));
  console.log('14. discover:', JSON.stringify(driver.getAnnouncedDevices()));
  const delay = (caps, plugged, cfg, err) => { Object.assign(device.caps, caps); device.pluggedIn = plugged; device.lastError = err || null; Object.assign(device.config, cfg); return device.nextPollDelay(); };
  console.log('15. poll delays: on =', delay({ onoff: true }, false, {}), '| off+charging =', delay({ onoff: false }, true, {}),
    '| off+battery =', delay({ onoff: false }, false, { poll_interval_idle: 300 }), '| off+battery, never =', delay({ onoff: false }, false, { poll_interval_idle: 0 }),
    '| unreachable =', delay({ onoff: false }, false, {}, 'x'));
  const offOn = delay({ onoff: true }, true, { keep_alive: false }); const offUnreachable = delay({ onoff: false }, false, { keep_alive: false }, 'x');
  console.log('    keep-alive off: screen on + charging =', offOn, '| unreachable =', offUnreachable);
  if (offOn !== 0 || offUnreachable !== 30) throw new Error('keep-alive off must mean no checks, except retrying while unreachable');
  device.config.keep_alive = true;
  device.lastError = null;
  const idle = new AdbClient({ host: '127.0.0.1', port, credentialStore: driver.credentialStore, idleTimeout: 300 });
  const events = [];
  idle.on('connect', ({ secure }) => events.push(`connect(secure=${secure})`));
  idle.on('disconnect', ({ reason }) => events.push(`disconnect(${reason})`));
  await Promise.all([idle.shell('dumpsys power | grep mWakefulness='), idle.shell('dumpsys power | grep mWakefulness=')]);
  const during = idle.connected; await new Promise((r) => setTimeout(r, 500)); const after = idle.connected;
  await idle.shell('input keyevent KEYCODE_SLEEP');
  console.log('16. keep-alive off: connected after command =', during, '| after idle =', after, '| reconnects for next command =', idle.connected);
  idle.setIdleTimeout(0); await new Promise((r) => setTimeout(r, 500)); console.log('    keep-alive back on: still connected =', idle.connected); await idle.disconnect();
  console.log('    events:', events.join(' '));
  const expected = 'connect(secure=true) disconnect(idle) connect(secure=true) disconnect(requested)';
  if (events.join(' ') !== expected) throw new Error(`connect/disconnect events: expected "${expected}"`);
  await device.onSettings({ newSettings: { ...device.config, keep_alive: false }, changedKeys: ['keep_alive'] });
  console.log('17. setting applied to client: idleTimeout =', device.client.idleTimeout);
  console.log('18. errors translated: unreachable ->', device.localizeError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).message.slice(0, 40),
    '| other errors unchanged =', device.localizeError(new Error('raw')).message === 'raw');
  const problems = checkTranslations();
  if (problems.length) throw new Error(`translations:\n${problems.join('\n')}`);
  console.log('19. translations complete:', LANGUAGES.length, 'languages');

  await device.poll();
  console.log('20. battery temperature =', device.caps.measure_temperature, '| bluetooth =', device.bluetoothOn, '| triggers so far:', triggered.length);
  if (device.caps.measure_temperature !== 31.2 || device.bluetoothOn !== false || triggered.length) throw new Error('temperature / bluetooth state');
  await device.setBluetooth(true);
  bluetooth = 0; await device.poll(); // switched off on the phone itself
  console.log('    bluetooth on via card, then off on the phone -> triggers:', triggered.join(', '));
  if (triggered.join() !== 'bluetooth_turned_on,bluetooth_turned_off') throw new Error('bluetooth triggers');
  await device.setDoNotDisturb('alarms'); const zenAlarms = zen; await device.setDoNotDisturb('off');
  await device.setAutoRotate(false);
  await device.showNotification("Door'bell", 'Someone is at the door; rm -rf /');
  console.log('    dnd alarms -> zen', zenAlarms, '| dnd off -> zen', zen, '| rotation', rotation, '| notification:', notifications[0].replace(/^exec:/, ''));
  if (zenAlarms !== 3 || zen !== 0 || rotation !== 0 || !notifications[0].includes("'Door'\\''bell'") || !notifications[0].includes("'Someone is at the door; rm -rf /'")) throw new Error('dnd / rotate / notification');
  await device.poll();
  const sensors = ['bluetooth_enabled', 'auto_rotate', 'dnd_mode', 'wifi_network', 'measure_signal_strength', 'foreground_app'].map((k) => `${k}=${device.caps[k]}`).join(' ');
  console.log('    sensors:', sensors);
  if (sensors !== 'bluetooth_enabled=false auto_rotate=false dnd_mode=Off wifi_network=Home Wi-Fi measure_signal_strength=-55 foreground_app=Spotify') throw new Error('sensor values');

  const more = ['screen_timeout', 'stay_awake', 'storage_free', 'speaker_playing', 'speaker_track', 'speaker_artist', 'speaker_album'].map((k) => `${k}=${device.caps[k]}`).join(' | ');
  console.log('21. status + media:', more);
  if (more !== 'screen_timeout=30 | stay_awake=true | storage_free=47.7 | speaker_playing=true | speaker_track=Hello, Goodbye | speaker_artist=The Beatles | speaker_album=Magical Mystery Tour') throw new Error('status / media values');
  await device.listeners.speaker_playing(false); await device.poll();
  console.log('    pause from Homey -> device playing =', playing, '| speaker_playing =', device.caps.speaker_playing);
  if (playing !== false || device.caps.speaker_playing !== false) throw new Error('media pause');
  triggered.length = 0; front = 'com.netflix.mediaclient'; wifiName = 'Guest'; await device.poll();
  console.log('22. app + Wi-Fi changed -> triggers:', triggered.join(', '), JSON.stringify(triggerTokens.foreground_app_changed), JSON.stringify(triggerTokens.wifi_network_changed));
  if (triggered.sort().join() !== 'foreground_app_changed,wifi_network_changed' || triggerTokens.foreground_app_changed.name !== 'Netflix' || triggerTokens.foreground_app_changed.package !== 'com.netflix.mediaclient' || triggerTokens.wifi_network_changed.network !== 'Guest') throw new Error('change triggers');
  const image = await device.takeScreenshot(); const chunks = []; await image.fn({ end: (b) => chunks.push(b) });
  console.log('23. screenshot: PNG', chunks[0].subarray(1, 4).toString(), chunks[0].length, 'bytes | image updated', image.updated, '| shown on device as', device.camera.title);
  if (chunks[0].subarray(1, 4).toString() !== 'PNG' || image.updated !== 1 || image !== device.camera.image) throw new Error('screenshot');
  await device.runShell('settings get global zen_mode');
  console.log('    Flow tags:', Object.values(flowTokens).map((tk) => `${tk.opts.title} [${tk.opts.type}]`).join(', '), '| shell tag =', flowTokens.shell_output_MOCKSERIAL.value);
  if (flowTokens.screenshot_MOCKSERIAL.value !== image || flowTokens.shell_output_MOCKSERIAL.value !== '0') throw new Error('flow tags');
  wake = 'Asleep'; await device.showOnScreen({ url: 'my.homey.app' });
  await device.closeApp('com.netflix.mediaclient'); await device.touch(540, 1200); await device.touch(540, 1800, 540, 600);
  await device.setStreamVolume('alarm', 100);
  const bad = await Promise.all([device.closeApp('x; reboot'), device.touch(1, 'x'), device.touch(-1, 5)].map((p) => p.then(() => 'accepted', (e) => e.message)));
  console.log('24. show: screen', wake, '| ran:', ran.join(' ; '), '| alarm volume', otherVolumes[4], '| bad input:', bad.join(' / '));
  if (wake !== 'Awake' || ran.join(' ; ') !== 'am force-stop com.netflix.mediaclient ; input tap 540 1200 ; input swipe 540 1800 540 600 300' || otherVolumes[4] !== 7 || bad.includes('accepted')) throw new Error('new actions');
  console.log('25. app names:', (await device.listApps('spot')).map((a) => `${a.name} (${a.description})`).join(', '), '|', (await device.listApps('chrome')).map((a) => a.name).join(', '));
  if ((await device.listApps('Spotify'))[0].name !== 'Spotify') throw new Error('app names');
  await device.reboot();
  console.log('    restart: device got reboot =', rebooted);
  if (rebooted !== 1) throw new Error('restart');
  await device.onUninit();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });

// Every language Homey itself is available in, for all texts: the manifests,
// /locales/<lang>.json and README.<lang>.txt. Placeholders and HTML must match English.
function checkTranslations() {
  const fs = require('fs'); const path = require('path'); const root = path.join(__dirname, '..');
  const problems = [];
  // &amp; may become a word ("IP address & Port" is "IP-adres en poort" on a Dutch phone).
  const signature = (s) => [...(s.match(/\[\[\w+\]\]|__\w+__|<\/?\w+>|&(?!amp;)\w+;|!\{\{/g) || [])].sort().join(' ');
  const walk = (node, where, fn) => {
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${where}.${i}`, fn));
    else if (node && typeof node === 'object') {
      if (typeof node.en === 'string') fn(node, where);
      else Object.keys(node).forEach((k) => walk(node[k], `${where}.${k}`, fn));
    }
  };
  for (const file of [...fs.readdirSync(path.join(root, '.homeycompose/capabilities')).map((f) => `.homeycompose/capabilities/${f}`), '.homeycompose/app.json', 'drivers/tablet/driver.compose.json', 'drivers/tablet/driver.flow.compose.json', 'drivers/tablet/driver.settings.compose.json']) {
    walk(JSON.parse(fs.readFileSync(path.join(root, file))), file, (texts, where) => {
      for (const lang of LANGUAGES) {
        if (typeof texts[lang] !== 'string' || !texts[lang].trim()) problems.push(`${where}: no ${lang}`);
        else if (signature(texts[lang]) !== signature(texts.en)) problems.push(`${where}: ${lang} placeholders differ`);
      }
    });
  }
  const { tags } = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose/app.json')));
  for (const lang of LANGUAGES) {
    if (!tags || !Array.isArray(tags[lang]) || !tags[lang].length) problems.push(`app.json tags: no ${lang}`);
  }
  const en = require('../locales/en.json');
  for (const lang of LANGUAGES.filter((l) => l !== 'en')) {
    const file = path.join(root, 'locales', `${lang}.json`);
    if (!fs.existsSync(file)) { problems.push(`locales/${lang}.json missing`); continue; }
    const tr = JSON.parse(fs.readFileSync(file));
    const compare = (a, b, where) => {
      if (typeof a === 'string') {
        if (typeof b !== 'string' || !b.trim()) problems.push(`${where}: no ${lang}`);
        else if (signature(a) !== signature(b)) problems.push(`${where}: ${lang} placeholders differ`);
        return;
      }
      Object.keys(a).forEach((k) => compare(a[k], b && b[k], `${where}.${k}`));
      Object.keys(b || {}).filter((k) => !(k in a)).forEach((k) => problems.push(`${where}.${k}: only in ${lang}`));
    };
    compare(en, tr, `locales/${lang}.json`);
    if (!fs.existsSync(path.join(root, `README.${lang}.txt`))) problems.push(`README.${lang}.txt missing`);
  }
  return problems;
}

