'use strict';

const crypto = require('node:crypto');

/**
 * SPAKE2 over edwards25519, compatible with BoringSSL's spake25519.cc
 * (the variant Android uses for Wireless debugging pairing).
 *
 * It follows BoringSSL step by step, including its quirks: the private scalar
 * is multiplied by the cofactor, and the password scalar is made a multiple
 * of eight by adding multiples of the group order.
 */

// Order of the prime-order subgroup.
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const M_HEX = '5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e';
const N_HEX = '10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778';

let pointPromise;
async function loadPoint() {
  if (!pointPromise) {
    pointPromise = import('@noble/curves/ed25519.js').then((m) => m.ed25519.Point);
    pointPromise.catch(() => { pointPromise = undefined; });
  }
  return pointPromise;
}

function leToBigInt(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

// Plain double-and-add with the exact integer scalar (no reduction mod L),
// because BoringSSL deliberately uses scalars that are not reduced.
function multiplyExact(point, scalar, zero) {
  let result = zero;
  let addend = point;
  let k = scalar;
  while (k > 0n) {
    if (k & 1n) result = result.add(addend);
    addend = addend.double();
    k >>= 1n;
  }
  return result;
}

function lengthPrefixed(data) {
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(data.length));
  return Buffer.concat([len, data]);
}

class Spake2 {

  /**
   * @param {'alice'|'bob'} role alice = pairing client, bob = pairing server
   * @param {Buffer} myName
   * @param {Buffer} theirName
   */
  constructor(role, myName, theirName) {
    this.role = role;
    this.myName = myName;
    this.theirName = theirName;
  }

  /** @returns {Promise<Buffer>} our 32-byte message */
  async generateMessage(password) {
    const Point = await loadPoint();
    this.Point = Point;
    const M = Point.fromBytes(Buffer.from(M_HEX, 'hex'));
    const N = Point.fromBytes(Buffer.from(N_HEX, 'hex'));

    // private key = (random mod L) * 8
    this.privateKey = (leToBigInt(crypto.randomBytes(64)) % L) << 3n;
    const P = multiplyExact(Point.BASE, this.privateKey, Point.ZERO);

    this.passwordHash = crypto.createHash('sha512').update(password).digest();
    let scalar = leToBigInt(this.passwordHash) % L;
    if (scalar & 1n) scalar += L;
    if (scalar & 2n) scalar += 2n * L;
    if (scalar & 4n) scalar += 4n * L;
    this.passwordScalar = scalar;

    this.myMask = this.role === 'alice' ? M : N;
    this.theirMask = this.role === 'alice' ? N : M;

    const Pstar = P.add(multiplyExact(this.myMask, scalar, Point.ZERO));
    this.myMessage = Buffer.from(Pstar.toBytes());
    return this.myMessage;
  }

  /** @returns {Buffer} 64 bytes of shared key material */
  processMessage(theirMessage) {
    const { Point } = this;
    if (theirMessage.length !== 32) throw new Error('Invalid SPAKE2 message');

    const Qstar = Point.fromBytes(theirMessage, true);
    const Q = Qstar.subtract(multiplyExact(this.theirMask, this.passwordScalar, Point.ZERO));
    const shared = Buffer.from(multiplyExact(Q, this.privateKey, Point.ZERO).toBytes());

    const hash = crypto.createHash('sha512');
    if (this.role === 'alice') {
      hash.update(lengthPrefixed(this.myName));
      hash.update(lengthPrefixed(this.theirName));
      hash.update(lengthPrefixed(this.myMessage));
      hash.update(lengthPrefixed(theirMessage));
    } else {
      hash.update(lengthPrefixed(this.theirName));
      hash.update(lengthPrefixed(this.myName));
      hash.update(lengthPrefixed(theirMessage));
      hash.update(lengthPrefixed(this.myMessage));
    }
    hash.update(lengthPrefixed(shared));
    hash.update(lengthPrefixed(this.passwordHash));
    return hash.digest();
  }

}

module.exports = Spake2;
