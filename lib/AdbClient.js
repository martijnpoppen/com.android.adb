'use strict';

const net = require('node:net');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');
const { createTlsCredentials } = require('./Certificate');

// Tango is ESM-only, so it is loaded with dynamic import() from CommonJS.
let tangoPromise;
function loadTango() {
  if (!tangoPromise) {
    tangoPromise = Promise.all([
      import('@yume-chan/adb'),
      import('@yume-chan/stream-extra'),
    ]).then(([adb, streams]) => ({ ...streams, ...adb }));
    tangoPromise.catch(() => { tangoPromise = undefined; });
  }
  return tangoPromise;
}

// 'STLS': adbd answers with this on an Android 11+ "Wireless debugging" port.
// Both sides then switch the same TCP connection to TLS.
const ADB_COMMAND_STLS = 0x534c5453;
const ADB_STLS_VERSION = 0x01000000;
const ADB_HEADER_SIZE = 24;
const NOT_PAIRED_MESSAGE = 'The device refused the secure connection. It is probably not paired with Homey (anymore): '
  + 'repair the device with a new pairing code.';

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function withTimeout(promise, ms, message, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(codedError(message, code)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Minimal ADB-over-TCP client that talks straight to adbd on the device.
 * No adb binary and no adb server involved.
 *
 * Emits: 'disconnect'
 */
class AdbClient extends EventEmitter {

  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port=5555]
   * @param {object} opts.credentialStore Tango AdbCredentialStore
   * @param {number} [opts.idleTimeout=0] Disconnect this many ms after the last
   *   command finished. 0 keeps the connection open.
   */
  constructor({ host, port = 5555, credentialStore, idleTimeout = 0 }) {
    super();
    this.host = host;
    this.port = Number(port) || 5555;
    this.credentialStore = credentialStore;
    this.adb = null;
    this.socket = null;
    this.connecting = null;
    this.idleTimeout = idleTimeout;
    this.idleTimer = null;
    this.running = 0;
  }

  setIdleTimeout(ms) {
    this.idleTimeout = ms;
    this._armIdleTimer();
  }

  _armIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.idleTimeout || this.running > 0 || !this.adb) return;
    this.idleTimer = setTimeout(() => {
      if (this.running === 0) this.disconnect('idle').catch(() => {});
    }, this.idleTimeout);
  }

  get connected() {
    return this.adb !== null;
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.connectTimeout=5000] TCP connect timeout
   * @param {number} [opts.authTimeout=10000] How long to wait for the handshake.
   *   Use a long value while pairing: the handshake only completes once the
   *   user taps "Allow" on the tablet.
   */
  async connect(opts = {}) {
    if (this.adb) return;
    if (!this.connecting) {
      this.connecting = this._connect(opts).finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  async _connect({ connectTimeout = 5000, authTimeout = 10000, purpose = '' } = {}) {
    const tango = await loadTango();
    const socket = await this._openSocket(connectTimeout);
    this.socket = socket;

    this.secure = false;

    try {
      const transport = await withTimeout(
        tango.AdbDaemonTransport.authenticate({
          serial: `${this.host}:${this.port}`,
          connection: this._createConnection(tango, socket),
          credentialStore: this.credentialStore,
        }),
        authTimeout,
        'ADB authentication timed out. Tap "Allow" on the device (and tick "Always allow from this computer").',
        'ADB_AUTH_TIMEOUT',
      ).catch((err) => {
        // After switching to TLS the device simply hangs up on unknown keys.
        if (this.secure && !/timed out/.test(err.message)) throw codedError(NOT_PAIRED_MESSAGE, 'ADB_NOT_PAIRED');
        throw err;
      });

      const adb = new tango.Adb(transport);
      this.adb = adb;
      this.emit('connect', { secure: this.secure, purpose });

      adb.disconnected
        .catch(() => {})
        .then(() => {
          // Closed by disconnect(): that already emitted 'disconnect'.
          if (this.adb !== adb) return;
          this.adb = null;
          if (this.socket) this.socket.destroy();
          this.socket = null;
          this.emit('disconnect', { reason: 'device' });
        });
    } catch (err) {
      if (this.socket) this.socket.destroy();
      socket.destroy();
      this.socket = null;
      throw err;
    }
  }

  _openSocket(timeout) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy(codedError(`Could not reach ${this.host}:${this.port} (timeout)`, 'ADB_UNREACHABLE'));
      }, timeout);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeListener('error', reject);
        // Detect a tablet that silently dropped off Wi-Fi.
        socket.setKeepAlive(true, 10000);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Wraps a net.Socket as Tango's AdbDaemonConnection: a readable stream of
   * ADB packets plus a writable stream of packets.
   *
   * When the device asks for TLS (Wireless debugging), the socket is upgraded
   * in place and the streams carry on over the encrypted connection. Tango
   * doesn't notice; it just sees the CNXN packet arrive afterwards.
   */
  _createConnection(tango, plainSocket) {
    const { AdbPacketHeader, Consumable, PushReadableStream } = tango;
    let current = plainSocket;

    const write = (data) => new Promise((resolve, reject) => {
      current.write(data, (err) => (err ? reject(err) : resolve()));
    });

    const upgradeToTls = async (detach) => {
      const key = await this.credentialStore.getOrCreateKey();
      const header = Buffer.alloc(ADB_HEADER_SIZE);
      header.writeUInt32LE(ADB_COMMAND_STLS, 0);
      header.writeUInt32LE(ADB_STLS_VERSION, 4);
      header.writeUInt32LE((ADB_COMMAND_STLS ^ 0xffffffff) >>> 0, 20);
      await write(header);
      detach();

      const secureSocket = await new Promise((resolve, reject) => {
        const s = tls.connect({
          socket: plainSocket,
          ...createTlsCredentials(key.buffer),
          // The device has a throw-away self-signed certificate; it authenticates
          // us by our client certificate, whose key was registered while pairing.
          rejectUnauthorized: false,
          minVersion: 'TLSv1.3',
        });
        s.once('secureConnect', () => {
          s.removeListener('error', reject);
          resolve(s);
        });
        s.once('error', reject);
      });
      this.secure = true;
      this.socket = secureSocket;
      current = secureSocket;
    };

    const readable = new PushReadableStream((controller) => {
      let buffer = Buffer.alloc(0);
      // Received but not yet joined to 'buffer'. A screenshot or photo arrives as packets of
      // up to 1 MB in pieces of 16 kB: joining on every piece copied ~30 MB per MB received.
      let chunks = [];
      let chunkBytes = 0;
      const fill = (needed) => {
        if (buffer.length >= needed) return true;
        if (buffer.length + chunkBytes < needed) return false;
        buffer = Buffer.concat([buffer, ...chunks]);
        chunks = [];
        chunkBytes = 0;
        return true;
      };
      let busy = false;
      let done = false;

      const fail = (err) => {
        if (done) return;
        done = true;
        try { controller.error(err); } catch (_) { /* already closed */ }
      };
      const end = () => {
        if (done) return;
        done = true;
        try { controller.close(); } catch (_) { /* already closed */ }
      };

      const pump = async () => {
        if (busy) return;
        busy = true;
        try {
          while (!done && fill(ADB_HEADER_SIZE)) {
            const payloadLength = buffer.readUInt32LE(12);
            if (!fill(ADB_HEADER_SIZE + payloadLength)) break;
            const packet = {
              command: buffer.readUInt32LE(0),
              arg0: buffer.readUInt32LE(4),
              arg1: buffer.readUInt32LE(8),
              payloadLength,
              checksum: buffer.readUInt32LE(16),
              magic: buffer.readUInt32LE(20),
              payload: new Uint8Array(buffer.subarray(ADB_HEADER_SIZE, ADB_HEADER_SIZE + payloadLength)),
            };
            buffer = buffer.subarray(ADB_HEADER_SIZE + payloadLength);

            if (packet.command === ADB_COMMAND_STLS && current === plainSocket) {
              await upgradeToTls(() => plainSocket.removeListener('data', onData));
              attach(current);
            } else {
              await controller.enqueue(packet);
            }
          }
        } finally {
          busy = false;
        }
      };

      const onData = (chunk) => {
        chunks.push(chunk);
        chunkBytes += chunk.length;
        pump().catch(fail);
      };
      const attach = (socket) => {
        socket.on('data', onData);
        socket.on('error', fail);
        socket.on('close', end);
      };

      attach(plainSocket);
      controller.abortSignal.addEventListener('abort', () => current.destroy());
    });

    const writable = new Consumable.WritableStream({
      write: (init) => {
        init.payloadLength = init.payload.length;
        return write(Buffer.concat([AdbPacketHeader.serialize(init), init.payload]));
      },
      close: () => { current.end(); },
      abort: () => { current.destroy(); },
    });

    return { readable, writable };
  }

  /**
   * Runs a shell command on the device and returns its output (stdout + stderr).
   * Connects first when needed.
   */
  /**
   * @param {string} command
   * @param {object} [opts]
   * @param {number} [opts.timeout=10000]
   * @param {string} [opts.purpose] Why we connect, for the 'connect' event (default: the command).
   */
  async shell(command, { timeout = 10000, purpose } = {}) {
    this.running++;
    clearTimeout(this.idleTimer);
    try {
      await this.connect({ purpose: purpose || command });
      const output = await withTimeout(
        this.adb.subprocess.noneProtocol.spawnWaitText(command),
        timeout,
        `ADB command timed out: ${command}`,
      );
      return output.trim();
    } catch (err) {
      // A hanging or broken connection is useless: drop it so the next call reconnects.
      await this.disconnect('error');
      throw err;
    } finally {
      this.running--;
      this._armIdleTimer();
    }
  }

  /**
   * Like shell(), but returns the raw bytes (for binary output such as 'screencap -p').
   * @returns {Promise<Buffer>}
   */
  async exec(command, { timeout = 20000, purpose } = {}) {
    this.running++;
    clearTimeout(this.idleTimer);
    try {
      await this.connect({ purpose: purpose || command });
      const bytes = await withTimeout(
        this.adb.subprocess.noneProtocol.spawnWait(command),
        timeout,
        `ADB command timed out: ${command}`,
      );
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch (err) {
      await this.disconnect('error');
      throw err;
    } finally {
      this.running--;
      this._armIdleTimer();
    }
  }

  /** Restarts the device through adbd's own reboot service. The connection then drops. */
  async reboot() {
    this.running++;
    try {
      await this.connect({ purpose: 'restart' });
      // The device hangs up while restarting; don't wait for a clean answer.
      await withTimeout(this.adb.power.reboot(), 10000, 'restart').catch(() => {});
    } finally {
      this.running--;
    }
    if (this.adb) await this.disconnect('device');
  }

  /**
   * Emits 'connect' ({ secure, purpose }) when a connection is ready and 'disconnect'
   * ({ reason }) once when it ends: 'idle' (idle timeout), 'error' (a command
   * failed), 'device' (the device hung up) or 'requested' (called directly).
   * @param {string} [reason='requested']
   */
  async disconnect(reason = 'requested') {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const { adb, socket } = this;
    this.adb = null;
    this.socket = null;
    if (adb) await adb.close().catch(() => {});
    if (socket) socket.destroy();
    if (adb) this.emit('disconnect', { reason });
  }

}

/**
 * The public key line as stored on the device: "<base64 key> <name>".
 * @param {{ buffer: Uint8Array, name?: string }} key
 */
async function getAdbPublicKey(key) {
  const { adbGeneratePublicKey } = await loadTango();
  const base64 = Buffer.from(adbGeneratePublicKey(key.buffer)).toString('base64');
  return key.name ? `${base64} ${key.name}` : base64;
}

module.exports = AdbClient;
module.exports.getAdbPublicKey = getAdbPublicKey;
