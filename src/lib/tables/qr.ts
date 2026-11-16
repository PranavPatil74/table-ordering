/**
 * Table QR codes: the link they carry, whether it is safe to print, and the QR image itself.
 *
 * A QR code carries ONLY `<origin>/menu?table=<code>`. No id, token, staff information, key or
 * secret is ever encoded. The origin comes from APP_BASE_URL (runtime; falls back to NEXT_PUBLIC_APP_URL), and printing is refused when
 * that origin cannot work for a customer's phone in production (see `qrExportPolicy`).
 */
import { encode } from "uqr";

import { normalizeTableCode, TABLE_CODE_FORMAT } from "./table-code";

/** The customer menu route Phase 4 will serve. Keep in sync with the Phase 4 route. */
export const QR_PATH = "/menu";
export const QR_PARAM = "table";

export function buildTableQrUrl(baseUrl: string, code: string): string {
  if (!TABLE_CODE_FORMAT.test(code)) throw new RangeError("Not a valid table code");
  if (!URL.canParse(baseUrl)) throw new RangeError("The public application URL is not a valid URL");
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new RangeError("The public application URL must be http or https");
  }
  return `${base.origin}${QR_PATH}?${QR_PARAM}=${encodeURIComponent(code)}`;
}

/** Reads a QR link back: the table code, or null if it is not one of our table links. */
export function parseTableQrUrl(url: string): { origin: string; code: string } | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.pathname !== QR_PATH) return null;
  if ([...parsed.searchParams.keys()].some((key) => key !== QR_PARAM)) return null;
  const code = normalizeTableCode(parsed.searchParams.get(QR_PARAM));
  return code ? { origin: parsed.origin, code } : null;
}

// ------------------------------------------------------------------------------------------
// Is the base URL usable by a customer's phone?
// ------------------------------------------------------------------------------------------

export type BaseUrlKind = "public" | "local";

export interface BaseUrlInfo {
  origin: string;
  host: string;
  kind: BaseUrlKind;
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "[::1]") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    return true;
  if (!host.includes(".") && !host.includes(":")) return true; // single-label names like "mypc"
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return false;
}

/** "local" means only this machine or its network can open the link. */
export function classifyBaseUrl(appUrl: string): BaseUrlInfo {
  const url = new URL(appUrl);
  return {
    origin: url.origin,
    host: url.host,
    kind: isPrivateHost(url.hostname) ? "local" : "public",
  };
}

export interface ExportPolicy {
  /** Download and print allowed? Preview is always allowed. */
  canExport: boolean;
  /** Mark exported files and printouts as test-only. */
  testOnly: boolean;
  reason?: string;
}

/**
 * - public origin: export freely.
 * - local origin during development: export, but every file and printout is marked TEST ONLY.
 * - local origin in a production build: REFUSED, so a localhost QR code can never be printed and
 *   stuck on a table by accident.
 */
export function qrExportPolicy(info: BaseUrlInfo, nodeEnv: string | undefined): ExportPolicy {
  if (info.kind === "public") return { canExport: true, testOnly: false };
  if (nodeEnv === "production") {
    return {
      canExport: false,
      testOnly: true,
      reason: `These QR codes point to ${info.host}, which customers' phones cannot open. Set APP_BASE_URL to your public https address and restart the server before printing.`,
    };
  }
  return {
    canExport: true,
    testOnly: true,
    reason: `These QR codes point to ${info.host}, so they only work on your own network. Files and printouts are marked TEST ONLY.`,
  };
}

export function qrFilename(code: string, extension: "svg" | "png", testOnly: boolean): string {
  return `table-${code.toLowerCase()}-qr${testOnly ? "-TEST-ONLY" : ""}.${extension}`;
}

// ------------------------------------------------------------------------------------------
// The QR image
// ------------------------------------------------------------------------------------------

/** Error correction Q (about 25%) survives lamination glare and table wear. */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: "Q", border: 0 }).data;
}

/** One SVG path covering every dark module of the matrix, plus its side length in modules. */
export function qrPath(matrix: readonly (readonly boolean[])[]): { d: string; size: number } {
  const size = matrix.length;
  let d = "";
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (row[x]) {
        const start = x;
        while (x < size && row[x]) x += 1;
        d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
      } else {
        x += 1;
      }
    }
  });
  return { d, size };
}

/** Quiet zone, in modules, required around a QR code by the specification. */
export const QR_QUIET_ZONE = 4;

/**
 * A standalone SVG file for a table's QR code (white background, 4-module quiet zone).
 * `testOnly` adds a red frame and a "TEST ONLY" caption outside the quiet zone, so a printout made
 * from a local or development link can never be mistaken for a real one (the code still scans).
 */
export function renderQrSvg(url: string, title: string, options?: { testOnly?: boolean }): string {
  const { d, size } = qrPath(qrMatrix(url));
  const full = size + QR_QUIET_ZONE * 2;
  const safeTitle = title.replace(/[<>&"']/g, "");
  const code =
    `<rect width="${full}" height="${full}" fill="#ffffff"/>` +
    `<path transform="translate(${QR_QUIET_ZONE} ${QR_QUIET_ZONE})" d="${d}" fill="#000000"/>`;
  if (!options?.testOnly) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" width="1024" height="1024" shape-rendering="crispEdges" role="img">` +
      `<title>${safeTitle}</title>${code}</svg>`
    );
  }
  const frame = 2;
  const caption = 5;
  const w = full + frame * 2;
  const h = full + frame * 2 + caption;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="1024" height="${Math.round((1024 * h) / w)}" role="img">` +
    `<title>${safeTitle} (TEST ONLY)</title>` +
    `<rect width="${w}" height="${h}" fill="#c81e1e"/>` +
    `<g transform="translate(${frame} ${frame})" shape-rendering="crispEdges">${code}</g>` +
    `<text x="${w / 2}" y="${h - 1.4}" font-family="Arial, Helvetica, sans-serif" font-size="3.6" font-weight="700" fill="#ffffff" text-anchor="middle">TEST ONLY - NOT FOR CUSTOMERS</text>` +
    `</svg>`
  );
}

/** RGBA pixels for a QR code (used for PNG export and for decoding it back in tests). */
export function qrPixels(
  matrix: readonly (readonly boolean[])[],
  modulePixels: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const full = (matrix.length + QR_QUIET_ZONE * 2) * modulePixels;
  const data = new Uint8ClampedArray(full * full * 4).fill(255);
  matrix.forEach((row, my) => {
    row.forEach((dark, mx) => {
      if (!dark) return;
      for (let py = 0; py < modulePixels; py += 1) {
        for (let px = 0; px < modulePixels; px += 1) {
          const x = (mx + QR_QUIET_ZONE) * modulePixels + px;
          const y = (my + QR_QUIET_ZONE) * modulePixels + py;
          const i = (y * full + x) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    });
  });
  return { data, width: full, height: full };
}
