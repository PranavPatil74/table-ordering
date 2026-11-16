import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Accessibility guard for the design tokens in src/app/globals.css.
 * WCAG 2.2: normal text needs >= 4.5:1 (1.4.3); UI component boundaries and focus
 * indicators need >= 3:1 (1.4.11).
 */
const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");

const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
const tokens = new Map<string, string>();
for (const match of rootBlock.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
  tokens.set(match[1] as string, (match[2] as string).toLowerCase());
}

function channel(hex: string, start: number): number {
  const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function token(name: string): string {
  const value = tokens.get(name);
  if (!value) throw new Error(`Design token --${name} not found as a 6-digit hex in globals.css`);
  return value;
}

describe("design token parsing", () => {
  it("finds the palette in globals.css", () => {
    expect(tokens.size).toBeGreaterThan(20);
    expect(token("background")).toBe("#fbf6ec");
    expect(token("primary")).toBe("#1f4d3a");
  });

  it("computes known contrast ratios correctly", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeGreaterThan(4.4);
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.6);
  });
});

describe("text contrast (>= 4.5:1)", () => {
  const textPairs: Array<[foreground: string, background: string]> = [
    ["foreground", "background"],
    ["card-foreground", "card"],
    ["popover-foreground", "popover"],
    ["primary-foreground", "primary"],
    ["primary-foreground", "primary-deep"],
    ["secondary-foreground", "secondary"],
    ["accent-foreground", "accent"],
    ["gold-foreground", "gold"],
    ["destructive-foreground", "destructive"],
    ["muted-foreground", "background"],
    ["muted-foreground", "muted"],
    ["muted-foreground", "card"],
    ["primary", "background"], // link / outline text
    ["accent", "background"], // accent used as text on the page
    ["status-new-foreground", "status-new"],
    ["status-accepted-foreground", "status-accepted"],
    ["status-preparing-foreground", "status-preparing"],
    ["status-ready-foreground", "status-ready"],
    ["status-served-foreground", "status-served"],
    ["status-cancelled-foreground", "status-cancelled"],
  ];

  it.each(textPairs)("--%s on --%s", (foreground, background) => {
    expect(contrast(token(foreground), token(background))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("UI boundary and focus contrast (>= 3:1)", () => {
  const boundaryPairs: Array<[foreground: string, background: string]> = [
    ["input", "card"],
    ["input", "background"],
    ["ring", "background"],
    ["ring", "card"],
  ];

  it.each(boundaryPairs)("--%s against --%s", (foreground, background) => {
    expect(contrast(token(foreground), token(background))).toBeGreaterThanOrEqual(3);
  });
});
