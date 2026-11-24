'use strict';

// Library errors carry a `code` and an English message (for the logs).
// These turn them into a message in the user's language.
const TRANSLATED = {
  ADB_NOT_PAIRED: 'errors.not_paired',
  ADB_PAIRING_FAILED: 'errors.pairing_failed',
  ADB_AUTH_TIMEOUT: 'errors.auth_timeout',
  ADB_UNREACHABLE: 'errors.unreachable',
  ECONNREFUSED: 'errors.unreachable',
  EHOSTUNREACH: 'errors.unreachable',
  ENETUNREACH: 'errors.unreachable',
  ETIMEDOUT: 'errors.unreachable',
};

/**
 * @param {object} homey this.homey of a driver or device
 * @param {Error} err
 * @param {string} address "host:port" for the unreachable message
 * @returns {Error} a translated copy, or err itself when it has no known code
 */
function localizeError(homey, err, address) {
  const key = err && TRANSLATED[err.code];
  if (!key) return err;
  return Object.assign(new Error(homey.__(key, { address })), { code: err.code });
}

module.exports = { localizeError };
