'use strict';

const crypto = require('node:crypto');

// Minimal DER helpers, just enough to build a self-signed X.509 certificate.
function der(tag, ...content) {
  const body = Buffer.concat(content);
  let len;
  if (body.length < 0x80) len = Buffer.from([body.length]);
  else if (body.length < 0x100) len = Buffer.from([0x81, body.length]);
  else len = Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}

function utcTime(date) {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return der(0x17, Buffer.from(`${s}Z`, 'ascii'));
}

const SHA256_WITH_RSA = der(0x30,
  der(0x06, Buffer.from('2a864886f70d01010b', 'hex')), // 1.2.840.113549.1.1.11
  der(0x05));

const NAME = der(0x30, der(0x31, der(0x30,
  der(0x06, Buffer.from('550403', 'hex')), // commonName
  der(0x0c, Buffer.from('Adb', 'utf8')))));

/**
 * Wireless debugging uses TLS with a client certificate. The device ignores
 * everything in the certificate except its public key, which must be the
 * ADB key that was paired.
 *
 * @param {Uint8Array} pkcs8 RSA private key (same key as used for classic ADB auth)
 * @returns {{ key: string, cert: string }} PEM encoded private key and certificate
 */
function createTlsCredentials(pkcs8) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });

  const now = Date.now();
  const tbs = der(0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), // version 3
    der(0x02, Buffer.from([1])), // serial number
    SHA256_WITH_RSA,
    NAME, // issuer
    der(0x30, utcTime(new Date(now - 86400e3)), utcTime(new Date(now + 10 * 365 * 86400e3))),
    NAME, // subject
    spki);

  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = der(0x30, tbs, SHA256_WITH_RSA, der(0x03, Buffer.from([0]), signature));

  return {
    key: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    cert: `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}

module.exports = { createTlsCredentials };
