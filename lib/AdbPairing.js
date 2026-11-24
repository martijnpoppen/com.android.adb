'use strict';

const tls = require('node:tls');
const crypto = require('node:crypto');
const Spake2 = require('./Spake2');
const { createTlsCredentials } = require('./Certificate');

const CLIENT_NAME = Buffer.from('adb pair client\0');
const SERVER_NAME = Buffer.from('adb pair server\0');
const EXPORTED_KEY_LABEL = 'adb-label\0';
const EXPORTED_KEY_SIZE = 64;
const HKDF_INFO = Buffer.from('adb pairing_auth aes-128-gcm key');

const HEADER_VERSION = 1;
const TYPE_SPAKE2_MSG = 0;
const TYPE_PEER_INFO = 1;
const PEER_INFO_SIZE = 8192;
const PEER_INFO_RSA_PUB_KEY = 0;
const MAX_PAYLOAD = PEER_INFO_SIZE * 2;

/** Reads exact byte counts from a socket. */
class SocketReader {

  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiting = null;
    this.error = null;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._flush();
    });
    const fail = (err) => {
      this.error = err || new Error('Connection closed by the device. Is the pairing code correct?');
      this._flush();
    };
    socket.on('error', fail);
    socket.on('close', () => fail());
  }

  _flush() {
    if (!this.waiting) return;
    const { length, resolve, reject } = this.waiting;
    if (this.buffer.length >= length) {
      this.waiting = null;
      const out = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      resolve(out);
    } else if (this.error) {
      this.waiting = null;
      reject(this.error);
    }
  }

  read(length) {
    return new Promise((resolve, reject) => {
      this.waiting = { length, resolve, reject };
      this._flush();
    });
  }

}

function packet(type, payload) {
  const header = Buffer.alloc(6);
  header.writeUInt8(HEADER_VERSION, 0);
  header.writeUInt8(type, 1);
  header.writeUInt32BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

async function readPacket(reader, expectedType) {
  const header = await reader.read(6);
  const version = header.readUInt8(0);
  const type = header.readUInt8(1);
  const length = header.readUInt32BE(2);
  if (version !== HEADER_VERSION) throw new Error(`Unsupported pairing protocol version ${version}`);
  if (type !== expectedType) throw new Error(`Unexpected pairing packet type ${type}`);
  if (length === 0 || length > MAX_PAYLOAD) throw new Error(`Invalid pairing packet size ${length}`);
  return reader.read(length);
}

function nonce(sequence) {
  const out = Buffer.alloc(12);
  out.writeBigUInt64LE(BigInt(sequence));
  return out;
}

function encrypt(key, sequence, data) {
  const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce(sequence));
  return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}

function decrypt(key, sequence, data) {
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce(sequence));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}

function connectTls({ host, port, key, cert, timeout }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      key,
      cert,
      // The device uses a throw-away self-signed certificate. The pairing code
      // (bound to this TLS session below) is what authenticates both sides.
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    });
    const timer = setTimeout(() => {
      socket.destroy(new Error(`Could not reach ${host}:${port} (timeout). Is the pairing dialog still open on the device?`));
    }, timeout);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Android 11+ "Pair device with pairing code".
 * Registers our ADB key on the device, like `adb pair host:port code`.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port The pairing port shown in the pairing dialog (not the connect port)
 * @param {string} opts.code The 6 digit pairing code
 * @param {Uint8Array} opts.privateKey PKCS#8 RSA private key
 * @param {string} opts.publicKey ADB public key line: "<base64> <name>"
 * @param {number} [opts.timeout=10000]
 */
async function pair({ host, port, code, privateKey, publicKey, timeout = 10000 }) {
  const socket = await connectTls({ host, port, timeout, ...createTlsCredentials(privateKey) });
  const timer = setTimeout(() => socket.destroy(new Error('Pairing timed out')), timeout);

  try {
    const reader = new SocketReader(socket);

    // Tie the password to this TLS session, so the pairing can't be relayed.
    const keyMaterial = socket.exportKeyingMaterial(EXPORTED_KEY_SIZE, EXPORTED_KEY_LABEL);
    const password = Buffer.concat([Buffer.from(String(code).trim(), 'utf8'), keyMaterial]);

    const spake = new Spake2('alice', CLIENT_NAME, SERVER_NAME);
    socket.write(packet(TYPE_SPAKE2_MSG, await spake.generateMessage(password)));
    const shared = spake.processMessage(await readPacket(reader, TYPE_SPAKE2_MSG));
    const aesKey = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 16));

    const peerInfo = Buffer.alloc(PEER_INFO_SIZE);
    peerInfo.writeUInt8(PEER_INFO_RSA_PUB_KEY, 0);
    peerInfo.write(publicKey, 1, PEER_INFO_SIZE - 2, 'utf8');
    socket.write(packet(TYPE_PEER_INFO, encrypt(aesKey, 0, peerInfo)));

    // A wrong pairing code shows up here: the device drops the connection,
    // or its reply can't be decrypted.
    let theirInfo;
    try {
      theirInfo = decrypt(aesKey, 0, await readPacket(reader, TYPE_PEER_INFO));
    } catch (err) {
      throw Object.assign(new Error('Pairing failed. Check the pairing code and pairing port and try again.'), { code: 'ADB_PAIRING_FAILED' });
    }

    const guid = theirInfo.subarray(1, theirInfo.indexOf(0, 1)).toString('utf8');
    return { guid };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

module.exports = {
  pair,
  // exported for the test mock
  _internal: {
    SocketReader, packet, readPacket, encrypt, decrypt,
    CLIENT_NAME, SERVER_NAME, EXPORTED_KEY_LABEL, EXPORTED_KEY_SIZE, HKDF_INFO,
    TYPE_SPAKE2_MSG, TYPE_PEER_INFO, PEER_INFO_SIZE,
  },
};
