import { describe, expect, it } from "vitest";

import { assertPaise, formatPaise, parseRupeesToPaise, sumPaise } from "./money";

describe("parseRupeesToPaise", () => {
  it.each([
    ["0", 0],
    ["249", 24900],
    ["249.5", 24950],
    ["249.50", 24950],
    ["19.99", 1999], // 19.99 * 100 === 1998.9999999999998 in floating point
    ["0.07", 7],
    ["  120  ", 12000],
  ])("parses %j as %i paise", (input, expected) => {
    expect(parseRupeesToPaise(input)).toBe(expected);
  });

  it.each(["", "abc", "-5", "1e3", "1,299", "12.345", "12.", ".5", "₹100", "1".repeat(10)])(
    "rejects %j",
    (input) => {
      expect(() => parseRupeesToPaise(input)).toThrow(RangeError);
    },
  );
});

describe("assertPaise", () => {
  it("accepts safe integers", () => {
    expect(() => assertPaise(0)).not.toThrow();
    expect(() => assertPaise(24950)).not.toThrow();
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects %s",
    (value) => {
      expect(() => assertPaise(value)).toThrow(RangeError);
    },
  );
});

describe("sumPaise", () => {
  it("adds integer amounts exactly", () => {
    expect(sumPaise([1999, 1999, 1999])).toBe(5997);
    expect(sumPaise([])).toBe(0);
  });

  it("rejects fractional terms", () => {
    expect(() => sumPaise([100, 0.5])).toThrow(RangeError);
  });
});

describe("formatPaise", () => {
  it("omits decimals for whole rupees", () => {
    expect(formatPaise(24900)).toBe("₹249");
  });

  it("shows two decimals when there are paise", () => {
    expect(formatPaise(24950)).toBe("₹249.50");
    expect(formatPaise(7)).toBe("₹0.07");
  });

  it("uses Indian digit grouping", () => {
    expect(formatPaise(12345600)).toBe("₹1,23,456");
  });

  it("refuses non-integer input", () => {
    expect(() => formatPaise(249.5)).toThrow(RangeError);
  });
});
