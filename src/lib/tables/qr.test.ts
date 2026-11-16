import jsQR from "jsqr";
import { describe, expect, it } from "vitest";

import {
  buildTableQrUrl,
  classifyBaseUrl,
  parseTableQrUrl,
  qrExportPolicy,
  qrFilename,
  qrMatrix,
  qrPath,
  qrPixels,
  renderQrSvg,
} from "./qr";
import {
  isOrderableTable,
  normalizeTableCode,
  suggestNextCode,
  tableCreateSchema,
} from "./table-code";

describe("buildTableQrUrl", () => {
  it("builds <origin>/menu?table=<code> from the public base URL", () => {
    expect(buildTableQrUrl("https://orders.example.com", "T05")).toBe(
      "https://orders.example.com/menu?table=T05",
    );
  });

  it("uses only the origin: paths, queries and trailing slashes in the base are dropped", () => {
    for (const base of [
      "https://orders.example.com/",
      "https://orders.example.com/admin?x=1#y",
      "https://orders.example.com:443",
    ]) {
      expect(buildTableQrUrl(base, "T05")).toBe("https://orders.example.com/menu?table=T05");
    }
    expect(buildTableQrUrl("http://localhost:3000", "T05")).toBe(
      "http://localhost:3000/menu?table=T05",
    );
  });

  it("refuses codes the database would refuse, and bad base URLs", () => {
    for (const code of ["", "t05", "5T", "T 05", "T05&admin=1", "T05/../x", "T".repeat(17)]) {
      expect(() => buildTableQrUrl("https://x.example", code), code).toThrow();
    }
    expect(() => buildTableQrUrl("not a url", "T05")).toThrow();
    expect(() => buildTableQrUrl("javascript:alert(1)", "T05")).toThrow();
  });

  it("round-trips through parseTableQrUrl", () => {
    for (const code of ["T01", "WINDOW-3", "BAR_1", "A1"]) {
      const url = buildTableQrUrl("https://orders.example.com", code);
      expect(parseTableQrUrl(url)).toEqual({ origin: "https://orders.example.com", code });
    }
  });

  it("parseTableQrUrl rejects anything that is not a plain table link", () => {
    for (const url of [
      "https://x.example/other?table=T01",
      "https://x.example/menu",
      "https://x.example/menu?table=bad code",
      "https://x.example/menu?table=T01&token=secret",
      "https://x.example/menu?id=123",
      "nonsense",
    ]) {
      expect(parseTableQrUrl(url), url).toBeNull();
    }
  });

  it("carries nothing but the table code: no ids, tokens or secrets", () => {
    const url = new URL(buildTableQrUrl("https://orders.example.com", "T05"));
    expect([...url.searchParams.keys()]).toEqual(["table"]);
    expect(url.username + url.password + url.hash).toBe("");
  });
});

describe("the QR image really encodes the table link", () => {
  const decode = (text: string, modulePixels: number) => {
    const { data, width, height } = qrPixels(qrMatrix(text), modulePixels);
    return jsQR(data, width, height)?.data;
  };

  it.each(["T01", "T05", "WINDOW-3", "TERRACE_12"])(
    "scanning table %s gives its URL back",
    (code) => {
      const url = buildTableQrUrl("https://orders.example.com", code);
      for (const modulePixels of [4, 8, 16]) {
        expect(decode(url, modulePixels), `${code} at ${modulePixels}px/module`).toBe(url);
      }
    },
  );

  it("works for a long production URL too", () => {
    const url = buildTableQrUrl("https://sandwich-express-orders.example-cafe.co.in", "TERRACE-12");
    expect(decode(url, 8)).toBe(url);
  });

  it("different tables give different, individually scannable codes", () => {
    const a = decode(buildTableQrUrl("https://x.example", "T01"), 8);
    const b = decode(buildTableQrUrl("https://x.example", "T02"), 8);
    expect(a).not.toBe(b);
  });

  it("the standalone SVG contains the same modules as the matrix, with a quiet zone", () => {
    const url = buildTableQrUrl("https://x.example", "T01");
    const svg = renderQrSvg(url, "Table T01");
    const { d, size } = qrPath(qrMatrix(url));
    expect(svg).toContain(`d="${d}"`);
    expect(svg).toContain(`viewBox="0 0 ${size + 8} ${size + 8}"`);
    expect(svg).toContain("<title>Table T01</title>");
    expect(svg).not.toMatch(/<script|onload|href/i);
  });

  it("SVG titles cannot inject markup", () => {
    const svg = renderQrSvg(
      "https://x.example/menu?table=T01",
      `Table "><script>alert(1)</script>`,
    );
    expect(svg).not.toContain("<script");
  });
});

describe("base URL safety", () => {
  it.each([
    ["http://localhost:3000", "local"],
    ["http://127.0.0.1:3000", "local"],
    ["http://192.168.1.20:3000", "local"],
    ["http://10.0.0.5", "local"],
    ["http://172.20.1.1", "local"],
    ["http://my-laptop.local:3000", "local"],
    ["http://mypc:3000", "local"],
    ["https://orders.example.com", "public"],
    ["https://sandwich-express.vercel.app", "public"],
    ["http://172.32.0.1", "public"],
    ["https://8.8.8.8", "public"],
  ] as const)("%s is %s", (url, kind) => {
    expect(classifyBaseUrl(url).kind).toBe(kind);
  });

  it("a public origin may always be exported", () => {
    const info = classifyBaseUrl("https://orders.example.com");
    for (const env of ["production", "development", undefined]) {
      expect(qrExportPolicy(info, env)).toEqual({ canExport: true, testOnly: false });
    }
  });

  it("a localhost origin is allowed in development but marked TEST ONLY", () => {
    const policy = qrExportPolicy(classifyBaseUrl("http://localhost:3000"), "development");
    expect(policy).toMatchObject({ canExport: true, testOnly: true });
    expect(policy.reason).toMatch(/TEST ONLY/);
  });

  it("a localhost origin is REFUSED in production, with the fix in the message", () => {
    for (const url of ["http://localhost:3000", "http://192.168.1.20:3000"]) {
      const policy = qrExportPolicy(classifyBaseUrl(url), "production");
      expect(policy.canExport).toBe(false);
      expect(policy.reason).toMatch(/APP_BASE_URL/);
    }
  });

  it("test-only files are named as such", () => {
    expect(qrFilename("T05", "png", false)).toBe("table-t05-qr.png");
    expect(qrFilename("T05", "svg", true)).toBe("table-t05-qr-TEST-ONLY.svg");
  });
});

describe("table codes", () => {
  it("normalises what a person typed or scanned", () => {
    expect(normalizeTableCode(" t05 ")).toBe("T05");
    for (const bad of ["", "5", "T 5", "T05;DROP", "../T05", null, undefined, 5, {}]) {
      expect(normalizeTableCode(bad), String(bad)).toBeNull();
    }
  });

  it("only active tables can take orders; unknown and deactivated ones cannot", () => {
    expect(isOrderableTable({ is_active: true })).toBe(true);
    expect(isOrderableTable({ is_active: false })).toBe(false);
    expect(isOrderableTable(null)).toBe(false);
    expect(isOrderableTable(undefined)).toBe(false);
  });

  it("suggests the next code in the T01 series", () => {
    expect(suggestNextCode([])).toBe("T01");
    expect(suggestNextCode(["T01", "T02", "T05"])).toBe("T06");
    expect(suggestNextCode(["T99"])).toBe("T100");
    expect(suggestNextCode(["WINDOW-1", "BAR"])).toBe("T01");
  });

  it("validates new tables like the database does", () => {
    expect(tableCreateSchema.safeParse({ code: " t06 ", label: "  Window   seat " })).toMatchObject(
      {
        success: true,
        data: { code: "T06", label: "Window seat" },
      },
    );
    for (const bad of [
      { code: "6", label: "x" },
      { code: "T06", label: "" },
      { code: "T06", label: "x".repeat(41) },
      { code: "T 06", label: "x" },
    ]) {
      expect(tableCreateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
