/**
 * `crypto.subtle` is exposed only in a secure context. The portal was reached over the LAN on plain
 * http, where it is simply undefined, until it moved to https; the
 * fallback stays until the old address has been gone long enough to be sure nothing still uses it.
 * The digest it produces is stored and compared — it is how an upload is recognised as one
 * already waiting in the queue — so the fallback has to be SHA-256 proper rather than any convenient
 * hash: the same file must fingerprint the same way whether it was read over http, over https, or
 * on the server.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const rotr = (value: number, bits: number) => ((value >>> bits) | (value << (32 - bits))) >>> 0;

/** FIPS 180-4 SHA-256, for the origins that do not expose `crypto.subtle`. */
function sha256Bytes(input: Uint8Array): Uint8Array {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  // The message, a 1 bit, zero padding, then the bit length as 64 bits big-endian, to a 64-byte block.
  const padded = new Uint8Array(((input.length + 9 + 63) >> 6) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = input.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const schedule = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(block + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const previous = schedule[index - 15]!;
      const recent = schedule[index - 2]!;
      const s0 = rotr(previous, 7) ^ rotr(previous, 18) ^ (previous >>> 3);
      const s1 = rotr(recent, 17) ^ rotr(recent, 19) ^ (recent >>> 10);
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + s1 + choice + K[index]! + schedule[index]!) >>> 0;
      const s0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    for (const [index, value] of [a!, b!, c!, d!, e!, f!, g!, h!].entries())
      state[index] = (state[index]! + value) >>> 0;
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let index = 0; index < 8; index += 1) out.setUint32(index * 4, state[index]!);
  return digest;
}

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The SHA-256 of `input` as lowercase hex, whether or not the origin is a secure context. */
export async function sha256Hex(input: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle)
    return hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input as BufferSource)));
  return hex(sha256Bytes(input));
}
