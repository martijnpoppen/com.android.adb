'use strict';

const { webcrypto } = require('node:crypto');

const SETTINGS_KEY = 'adb_private_key';
// The name the device shows for this key (Wireless debugging > Paired devices).
// The app SDK can't read the Homey's own name, so it is simply "Homey".
const KEY_NAME = 'Homey';

/**
 * Keeps one RSA key pair for the whole app in Homey's app settings, so every
 * tablet only has to show the "Allow USB debugging?" prompt once.
 *
 * Implements Tango's AdbCredentialStore interface (generateKey / iterateKeys).
 */
class CredentialStore {

  constructor(homey) {
    this.homey = homey;
  }

  async generateKey() {
    const { privateKey } = await webcrypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: 'SHA-1',
      },
      true,
      ['sign', 'verify'],
    );
    const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', privateKey));
    this.homey.settings.set(SETTINGS_KEY, pkcs8.toString('base64'));
    return { buffer: new Uint8Array(pkcs8), name: KEY_NAME };
  }

  /** Returns the stored key, creating it on first use. */
  async getOrCreateKey() {
    for (const key of this.iterateKeys()) return key;
    return this.generateKey();
  }

  * iterateKeys() {
    const stored = this.homey.settings.get(SETTINGS_KEY);
    if (stored) {
      yield { buffer: new Uint8Array(Buffer.from(stored, 'base64')), name: KEY_NAME };
    }
  }

}

module.exports = CredentialStore;
