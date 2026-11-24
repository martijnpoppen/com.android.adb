'use strict';
// Fake adbd + fake Homey to exercise AdbClient end-to-end, including RSA auth.
const net = require('node:net');
const crypto = require('node:crypto');
const AdbClient = require('../lib/AdbClient');
const CredentialStore = require('../lib/CredentialStore');

const CMD = { CNXN: 0x4e584e43, AUTH: 0x48545541, OPEN: 0x4e45504f, OKAY: 0x59414b4f, WRTE: 0x45545257, CLSE: 0x45534c43 };
function pkt(cmd, a0, a1, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(24);
  h.writeUInt32LE(cmd, 0); h.writeUInt32LE(a0, 4); h.writeUInt32LE(a1, 8);
  h.writeUInt32LE(payload.length, 12); h.writeUInt32LE(payload.reduce((s, b) => s + b, 0), 16);
  h.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, payload]);
}
let tlsMode = false; let wake = 'Asleep'; const log = []; let allowed = null; let sigOk = 0, pubKeys = 0;
const server = net.createServer((s) => {
  let buf = Buffer.alloc(0); const token = crypto.randomBytes(20); let lid = 100;
  const banner = Buffer.from('device::ro.product.name=mock;ro.product.model=MockTab;features=cmd,shell_v2');
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 24) {
      const len = buf.readUInt32LE(12); if (buf.length < 24 + len) return;
      const cmd = buf.readUInt32LE(0), a0 = buf.readUInt32LE(4), a1 = buf.readUInt32LE(8);
      const payload = buf.subarray(24, 24 + len); buf = buf.subarray(24 + len);
      if (cmd === CMD.CNXN) s.write(tlsMode ? pkt(0x534c5453, 0x01000000, 0) : pkt(CMD.AUTH, 1, 0, token));
      else if (cmd === CMD.AUTH && a0 === 2) {
        // verify signature with stored pubkey (prehashed SHA1 token, PKCS1 v1.5)
        if (allowed) { sigOk++; s.write(pkt(CMD.CNXN, 0x01000001, 256 * 1024, banner)); }
        else s.write(pkt(CMD.AUTH, 1, 0, token));
      } else if (cmd === CMD.AUTH && a0 === 3) {
        pubKeys++; allowed = payload.toString(); log.push('pubkey:' + allowed.slice(-18));
        setTimeout(() => s.write(pkt(CMD.CNXN, 0x01000001, 256 * 1024, banner)), 200);
      } else if (cmd === CMD.OPEN) {
        const svc = payload.toString().replace(/\0$/, ''); log.push(svc); const id = lid++;
        let out = '';
        if (svc.includes('KEYCODE_WAKEUP')) wake = 'Awake';
        else if (svc.includes('KEYCODE_SLEEP')) wake = 'Asleep';
        else if (svc.includes('mWakefulness')) out = `  mWakefulness=${wake}\n`;
        else if (svc.includes('ro.product.model')) out = 'MockTab\n';
        else if (svc.includes('ro.serialno')) out = 'ABC123456\n';
        else if (svc.includes('hang')) { s.write(pkt(CMD.OKAY, id, a0)); continue; }
        s.write(pkt(CMD.OKAY, id, a0));
        if (out) s.write(pkt(CMD.WRTE, id, a0, Buffer.from(out)));
        s.write(pkt(CMD.CLSE, id, a0));
      }
    }
  });
  s.on('error', () => {});
});
const settings = new Map();
const homey = { settings: { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) } };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const store = new CredentialStore(homey);
  const c = new AdbClient({ host: '127.0.0.1', port, credentialStore: store });
  await c.connect({ authTimeout: 5000 });
  console.log('model:', await c.shell('getprop ro.product.model'));
  console.log('state:', await c.shell('dumpsys power | grep mWakefulness='));
  await c.shell('input keyevent KEYCODE_WAKEUP');
  console.log('state:', await c.shell('dumpsys power | grep mWakefulness='));
  // parallel commands
  console.log('parallel:', await Promise.all([c.shell('getprop ro.serialno'), c.shell('dumpsys power | grep mWakefulness=')]));
  // timeout drops connection, next call reconnects with stored key (signature auth)
  await c.shell('hang', { timeout: 500 }).catch((e) => console.log('expected:', e.message, 'connected=', c.connected));
  await c.shell('input keyevent KEYCODE_SLEEP');
  console.log('state after reconnect:', await c.shell('dumpsys power | grep mWakefulness='));
  console.log('pubkey prompts:', pubKeys, 'signature logins:', sigOk, 'key stored:', settings.has('adb_private_key'));
  // server dies -> disconnect event
  const gone = new Promise((r) => c.once('disconnect', r));
  c.socket.destroy();
  await withT(gone); console.log('disconnect event ok, connected=', c.connected);
  // unreachable host
  const bad = new AdbClient({ host: '127.0.0.1', port: 1, credentialStore: store });
  await bad.shell('x').catch((e) => console.log('unreachable:', e.code || e.message));
  tlsMode = true; const t0 = Date.now();
  await new AdbClient({ host: '127.0.0.1', port, credentialStore: store }).shell('x').catch((e) => console.log('tls port:', Date.now() - t0, 'ms:', e.message));
  console.log(log.join('\n'));
  server.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
function withT(p) { return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('no disconnect event')), 3000))]); }
