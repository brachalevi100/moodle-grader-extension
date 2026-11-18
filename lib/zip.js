// Minimal ZIP reader/writer with no dependencies.
// Reader: supports "stored" (0) and "deflate" (8) entries via DecompressionStream.
// Writer: creates "stored" (uncompressed) ZIPs with UTF-8 filenames.
(function (root) {
  'use strict';

  // ---------- CRC32 ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- Filename decoding ----------
  // Windows "Send to > Compressed folder" on Hebrew systems historically used CP862 (OEM Hebrew).
  function decodeCp862(bytes) {
    let s = '';
    for (const b of bytes) {
      if (b < 0x80) s += String.fromCharCode(b);
      else if (b <= 0x9a) s += String.fromCharCode(0x05d0 + (b - 0x80)); // א..ת
      else s += '_';
    }
    return s;
  }

  function decodeName(bytes, utf8Flag) {
    if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      return decodeCp862(bytes);
    }
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---------- Reader ----------
  // Returns [{ name, dir, size, encrypted, read: async () => Uint8Array }]
  function readZip(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Find End Of Central Directory record.
    let eocd = -1;
    const minPos = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (EOCD not found)');

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];

    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const size = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen), (flags & 0x0800) !== 0)
        .replace(/\\/g, '/');
      p += 46 + nameLen + extraLen + commentLen;

      entries.push({
        name,
        dir: name.endsWith('/'),
        size,
        encrypted: (flags & 1) !== 0,
        method,
        async read() {
          if (this.encrypted) throw new Error('Encrypted entry: ' + name);
          const lNameLen = dv.getUint16(localOffset + 26, true);
          const lExtraLen = dv.getUint16(localOffset + 28, true);
          const start = localOffset + 30 + lNameLen + lExtraLen;
          const data = bytes.subarray(start, start + compSize);
          if (method === 0) return data.slice();
          if (method === 8) return inflateRaw(data);
          throw new Error('Unsupported compression method ' + method + ' in ' + name);
        },
      });
    }
    return entries;
  }

  // ---------- Writer ----------
  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  // files: [{ name: string, data: Uint8Array }] -> Uint8Array
  function writeZip(files) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);

      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 names
      lv.setUint16(8, 0, true); // stored
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);

      locals.push(lh, data);
      centrals.push(ch);
      offset += lh.length + data.length;
    }

    const cdSize = centrals.reduce((a, c) => a + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const out = new Uint8Array(offset + cdSize + 22);
    let q = 0;
    for (const part of [...locals, ...centrals, eocd]) { out.set(part, q); q += part.length; }
    return out;
  }

  function isZip(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
      (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6);
  }

  const api = { readZip, writeZip, isZip, crc32 };
  root.MiniZip = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
