import { inflateSync } from "node:zlib";

import jsQR from "jsqr";
import { describe, expect, it } from "vitest";

import { renderQrPng } from "./png";
import { buildTableQrUrl, renderQrSvg } from "./qr";

const URL_T06 = buildTableQrUrl("https://orders.example.com", "T06");

/** Minimal PNG reader for our own RGB output: returns RGBA pixels. */
function decodePng(png: Buffer) {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(png[24]).toBe(8);
  expect(png[25]).toBe(2);
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (width * 3 + 1)]).toBe(0);
    for (let x = 0; x < width; x += 1) {
      const from = y * (width * 3 + 1) + 1 + x * 3;
      const to = (y * width + x) * 4;
      rgba[to] = raw[from]!;
      rgba[to + 1] = raw[from + 1]!;
      rgba[to + 2] = raw[from + 2]!;
      rgba[to + 3] = 255;
    }
  }
  return { rgba, width, height };
}

describe("PNG export", () => {
  it("is a valid PNG whose QR code decodes back to the table link", () => {
    const { rgba, width, height } = decodePng(renderQrPng(URL_T06, { testOnly: false }));
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(900);
    expect(jsQR(rgba, width, height)?.data).toBe(URL_T06);
  });

  it("a test-only PNG still scans, and carries a red frame so it cannot pass for a real one", () => {
    const { rgba, width, height } = decodePng(renderQrPng(URL_T06, { testOnly: true }));
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([200, 30, 30]);
    expect(jsQR(rgba, width, height)?.data).toBe(URL_T06);
  });

  it("the normal PNG has a white corner (no frame)", () => {
    const { rgba } = decodePng(renderQrPng(URL_T06, { testOnly: false }));
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([255, 255, 255]);
  });
});

describe("SVG test-only marking", () => {
  it("is unmarked for a real public URL", () => {
    const svg = renderQrSvg(URL_T06, "Table 6");
    expect(svg).not.toMatch(/TEST ONLY/);
  });

  it("is clearly marked when test-only, and the title can't inject markup", () => {
    const svg = renderQrSvg(URL_T06, 'Table <script>alert("x")</script>', { testOnly: true });
    expect(svg).toMatch(/TEST ONLY - NOT FOR CUSTOMERS/);
    expect(svg).not.toMatch(/<script/);
  });
});
