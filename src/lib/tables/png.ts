/**
 * A tiny PNG writer (8-bit RGB, no dependencies) so QR codes can be downloaded as images.
 * Uses only node:zlib; runs on the server.
 */
import { deflateSync } from "node:zlib";

import { qrMatrix, qrPixels, QR_QUIET_ZONE } from "./qr";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes RGBA pixels (alpha ignored) as an RGB PNG. */
export function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const to = y * stride + 1 + x * 3;
      raw[to] = rgba[from]!;
      raw[to + 1] = rgba[from + 1]!;
      raw[to + 2] = rgba[from + 2]!;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * The QR code as a PNG about 1000px wide. A test-only code gets a thick RED frame outside the
 * quiet zone, so a test printout can never be mistaken for a real one (the code still scans).
 */
export function renderQrPng(url: string, options: { testOnly: boolean }): Buffer {
  const matrix = qrMatrix(url);
  const modules = matrix.length + QR_QUIET_ZONE * 2;
  const modulePixels = Math.max(4, Math.ceil(1000 / modules));
  const { data, width, height } = qrPixels(matrix, modulePixels);
  if (!options.testOnly) return encodePng(data, width, height);

  const frame = modulePixels * 2;
  const outerW = width + frame * 2;
  const outerH = height + frame * 2;
  const framed = new Uint8ClampedArray(outerW * outerH * 4);
  for (let i = 0; i < framed.length; i += 4) {
    framed[i] = 200;
    framed[i + 1] = 30;
    framed[i + 2] = 30;
    framed[i + 3] = 255;
  }
  for (let y = 0; y < height; y += 1) {
    const from = y * width * 4;
    framed.set(data.subarray(from, from + width * 4), ((y + frame) * outerW + frame) * 4);
  }
  return encodePng(framed, outerW, outerH);
}
