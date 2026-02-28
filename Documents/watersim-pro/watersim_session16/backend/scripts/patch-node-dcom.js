#!/usr/bin/env node
/**
 * Patches node-dcom-fix to fix bugs and compatibility issues:
 *
 *  ntlmauthentication.js:
 *   1. Missing Encdec require
 *   2. Incorrect "new Encdec()" usage (Encdec is a plain object, not a class)
 *   3. targetInformation not being a Buffer (readUInt16LE fails on Arrays)
 *
 *  responses.js:
 *   4. Replace native crypto with crypto-compat (pure-JS MD4/DES-ECB fallbacks
 *      for OpenSSL 3.x which dropped legacy algorithms)
 *
 *  crypto-compat.js:
 *   5. Install pure-JS crypto compatibility module alongside responses.js
 *
 * Run automatically via postinstall.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const securityDir = path.resolve(
  __dirname, '..', '..', 'node_modules', 'node-dcom-fix',
  'dcom', 'rpc', 'security'
);

const ntlmFile = path.join(securityDir, 'ntlmauthentication.js');
const responsesFile = path.join(securityDir, 'responses.js');
const cryptoCompatFile = path.join(securityDir, 'crypto-compat.js');

if (!fs.existsSync(ntlmFile)) {
  console.log('[patch-node-dcom] node-dcom-fix not found, skipping.');
  process.exit(0);
}

let patched = false;

// ── Patch ntlmauthentication.js ─────────────────────────────────────────────

let ntlmSrc = fs.readFileSync(ntlmFile, 'utf8');

if (!ntlmSrc.includes("require('../../ndr/encdec.js')")) {
  // 1. Add missing Encdec require
  ntlmSrc = ntlmSrc.replace(
    "const Responses = require('./responses.js');",
    "const Responses = require('./responses.js');\nconst Encdec = require('../../ndr/encdec.js');"
  );

  // 2. Fix incorrect "new Encdec()" and "new Encdec." calls
  ntlmSrc = ntlmSrc.replace(/new Encdec\(\)\.dec_uint16le/g, 'Encdec.dec_uint16le');
  ntlmSrc = ntlmSrc.replace(/new Encdec\.dec_uint16le/g, 'Encdec.dec_uint16le');

  // 3. Ensure targetInformation is a Buffer before calling readUInt16LE
  ntlmSrc = ntlmSrc.replace(
    'getTargetFromTargetInformation(targetInformation)\n  {\n    var target = null;\n    var i = 0;\n    while',
    'getTargetFromTargetInformation(targetInformation)\n  {\n    var target = null;\n    var i = 0;\n    if (targetInformation && !Buffer.isBuffer(targetInformation)) {\n      targetInformation = Buffer.from(targetInformation);\n    }\n    while'
  );

  fs.writeFileSync(ntlmFile, ntlmSrc, 'utf8');
  console.log('[patch-node-dcom] Patched ntlmauthentication.js');
  patched = true;
} else {
  console.log('[patch-node-dcom] ntlmauthentication.js already patched.');
}

// ── Patch responses.js — use crypto-compat instead of native crypto ─────────

let resSrc = fs.readFileSync(responsesFile, 'utf8');

if (!resSrc.includes('crypto-compat')) {
  // 4. Replace "require('crypto')" with "require('./crypto-compat')"
  resSrc = resSrc.replace(
    "const Crypto = require('crypto');",
    "const Crypto = require('./crypto-compat');"
  );

  fs.writeFileSync(responsesFile, resSrc, 'utf8');
  console.log('[patch-node-dcom] Patched responses.js → crypto-compat');
  patched = true;
} else {
  console.log('[patch-node-dcom] responses.js already patched.');
}

// ── Install crypto-compat.js ────────────────────────────────────────────────

const cryptoCompatSrc = `/**
 * crypto-compat.js — Drop-in wrapper for Node.js crypto module.
 *
 * Provides pure-JS fallbacks for MD4 hash and DES-ECB cipher when
 * the native OpenSSL 3.x build no longer includes legacy algorithms.
 * All other algorithms delegate to the native crypto module.
 */
'use strict';

const Crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════════════
// Pure-JS MD4 (RFC 1320)
// ═══════════════════════════════════════════════════════════════════════════

function md4Compute(buf) {
  const msgLen = buf.length;
  const bitLen = msgLen * 8;
  let padLen = 56 - (msgLen % 64);
  if (padLen <= 0) padLen += 64;
  const padded = Buffer.alloc(msgLen + padLen + 8);
  buf.copy(padded);
  padded[msgLen] = 0x80;
  padded.writeUInt32LE(bitLen >>> 0, msgLen + padLen);
  padded.writeUInt32LE(Math.floor(bitLen / 0x100000000) >>> 0, msgLen + padLen + 4);

  let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const add  = (a, b) => (a + b) >>> 0;
  const F = (x, y, z) => ((x & y) | (~x & z)) >>> 0;
  const G = (x, y, z) => ((x & y) | (x & z) | (y & z)) >>> 0;
  const H = (x, y, z) => (x ^ y ^ z) >>> 0;

  for (let i = 0; i < padded.length; i += 64) {
    const X = new Array(16);
    for (let j = 0; j < 16; j++) X[j] = padded.readUInt32LE(i + j * 4);
    let aa = a, bb = b, cc = c, dd = d;

    const R1 = [[0,3],[1,7],[2,11],[3,19],[4,3],[5,7],[6,11],[7,19],
                [8,3],[9,7],[10,11],[11,19],[12,3],[13,7],[14,11],[15,19]];
    for (const [k, s] of R1) {
      a = rotl(add(add(add(a, F(b, c, d)), X[k]), 0), s);
      const t = a; a = d; d = c; c = b; b = t;
    }
    const R2 = [[0,3],[4,5],[8,9],[12,13],[1,3],[5,5],[9,9],[13,13],
                [2,3],[6,5],[10,9],[14,13],[3,3],[7,5],[11,9],[15,13]];
    for (const [k, s] of R2) {
      a = rotl(add(add(add(a, G(b, c, d)), X[k]), 0x5A827999), s);
      const t = a; a = d; d = c; c = b; b = t;
    }
    const R3 = [[0,3],[8,9],[4,11],[12,15],[2,3],[10,9],[6,11],[14,15],
                [1,3],[9,9],[5,11],[13,15],[3,3],[11,9],[7,11],[15,15]];
    for (const [k, s] of R3) {
      a = rotl(add(add(add(a, H(b, c, d)), X[k]), 0x6ED9EBA1), s);
      const t = a; a = d; d = c; c = b; b = t;
    }
    a = add(a, aa); b = add(b, bb); c = add(c, cc); d = add(d, dd);
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0); out.writeUInt32LE(b, 4);
  out.writeUInt32LE(c, 8); out.writeUInt32LE(d, 12);
  return out;
}

class MD4Hash {
  constructor() { this._bufs = []; }
  update(data) {
    this._bufs.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return this;
  }
  digest(enc) {
    const result = md4Compute(Buffer.concat(this._bufs));
    if (enc === 'hex') return result.toString('hex');
    if (enc === 'base64') return result.toString('base64');
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure-JS DES-ECB (FIPS 46-3)
// ═══════════════════════════════════════════════════════════════════════════

const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,
  62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,
  57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,
  61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
const FP_ = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,
  38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,
  36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,
  34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
const EX = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,
  16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1];
const PP = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,
  2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,
  63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,
  41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const SBOX = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,
   4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,
   0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,
   13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,
   10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,
   4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,
   9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,
   1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,2,0,14,9,11,
   7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11]
];

function bytesToBits(buf) {
  const bits = new Array(64);
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++)
      bits[i * 8 + j] = (buf[i] >>> (7 - j)) & 1;
  return bits;
}
function bitsToBytes(bits) {
  const buf = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i * 8 + j] & 1);
    buf[i] = byte;
  }
  return buf;
}
function permute(bits, table) {
  const out = new Array(table.length);
  for (let i = 0; i < table.length; i++) out[i] = bits[table[i] - 1];
  return out;
}
function leftRotate28(bits, n) { return bits.slice(n).concat(bits.slice(0, n)); }
function generateSubkeys(keyBuf) {
  const keyBits = bytesToBits(keyBuf);
  const pc1 = permute(keyBits, PC1);
  let C = pc1.slice(0, 28), D = pc1.slice(28, 56);
  const subkeys = [];
  for (let i = 0; i < 16; i++) {
    C = leftRotate28(C, SHIFTS[i]); D = leftRotate28(D, SHIFTS[i]);
    subkeys.push(permute(C.concat(D), PC2));
  }
  return subkeys;
}
function desEncryptBlock(keyBuf, blockBuf) {
  const subkeys = generateSubkeys(keyBuf);
  const bits = permute(bytesToBits(blockBuf), IP);
  let L = bits.slice(0, 32), R = bits.slice(32, 64);
  for (let i = 0; i < 16; i++) {
    const expanded = permute(R, EX);
    const xored = expanded.map((b, j) => b ^ subkeys[i][j]);
    const sOut = new Array(32);
    for (let s = 0; s < 8; s++) {
      const o = s * 6;
      const row = (xored[o] << 1) | xored[o + 5];
      const col = (xored[o+1] << 3) | (xored[o+2] << 2) | (xored[o+3] << 1) | xored[o+4];
      const val = SBOX[s][row * 16 + col];
      for (let b = 0; b < 4; b++) sOut[s * 4 + b] = (val >>> (3 - b)) & 1;
    }
    const pOut = permute(sOut, PP);
    const newR = L.map((b, j) => b ^ pOut[j]);
    L = R; R = newR;
  }
  return bitsToBytes(permute(R.concat(L), FP_));
}

class DESCipherECB {
  constructor(key) { this._key = Buffer.isBuffer(key) ? key : Buffer.from(key); this._bufs = []; }
  update(data) {
    const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const out = [];
    for (let i = 0; i < input.length; i += 8) {
      const block = input.slice(i, i + 8);
      if (block.length === 8) out.push(desEncryptBlock(this._key, block));
    }
    const result = Buffer.concat(out);
    this._bufs.push(result);
    return result;
  }
  final() { return Buffer.alloc(0); }
  setAutoPadding() { return this; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Wrapped exports — try native first, fall back to pure JS
// ═══════════════════════════════════════════════════════════════════════════

let nativeMD4 = null, nativeDES = null;
function testNativeMD4() {
  if (nativeMD4 !== null) return nativeMD4;
  try { Crypto.createHash('md4').update('t').digest(); nativeMD4 = true; }
  catch (_) { nativeMD4 = false; }
  return nativeMD4;
}
function testNativeDES() {
  if (nativeDES !== null) return nativeDES;
  try { const c = Crypto.createCipheriv('des-ecb', Buffer.alloc(8), ''); c.update(Buffer.alloc(8)); c.final(); nativeDES = true; }
  catch (_) { nativeDES = false; }
  return nativeDES;
}
function createHash(alg) {
  if (alg === 'md4' && !testNativeMD4()) return new MD4Hash();
  return Crypto.createHash(alg);
}
function createCipheriv(alg, key, iv) {
  if ((alg === 'des-ecb' || alg === 'ded-ecb') && !testNativeDES()) return new DESCipherECB(key);
  if (alg === 'ded-ecb') alg = 'des-ecb';
  return Crypto.createCipheriv(alg, key, iv);
}
function createHmac(alg, key) { return Crypto.createHmac(alg, key); }
module.exports = { createHash, createCipheriv, createHmac };
`;

// 5. Write crypto-compat.js if it doesn't exist or if it's outdated
if (!fs.existsSync(cryptoCompatFile) || !fs.readFileSync(cryptoCompatFile, 'utf8').includes('Pure-JS DES-ECB')) {
  fs.writeFileSync(cryptoCompatFile, cryptoCompatSrc, 'utf8');
  console.log('[patch-node-dcom] Installed crypto-compat.js');
  patched = true;
} else {
  console.log('[patch-node-dcom] crypto-compat.js already installed.');
}

if (patched) {
  console.log('[patch-node-dcom] All patches applied successfully.');
} else {
  console.log('[patch-node-dcom] All patches already applied.');
}
