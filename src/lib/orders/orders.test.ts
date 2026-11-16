import { describe, expect, it } from "vitest";

import { formatOrderNumber, parseOrderNumber } from "./order-number";
import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  canTransitionOrder,
  canTransitionPayment,
  nextPreparationStatus,
} from "./status";

describe("order status machine", () => {
  it("allows the normal forward path one step at a time", () => {
    expect(canTransitionOrder("NEW", "ACCEPTED")).toBe(true);
    expect(canTransitionOrder("ACCEPTED", "PREPARING")).toBe(true);
    expect(canTransitionOrder("PREPARING", "READY")).toBe(true);
    expect(canTransitionOrder("READY", "SERVED")).toBe(true);
  });

  it("does not allow skipping steps or going backwards", () => {
    expect(canTransitionOrder("NEW", "PREPARING")).toBe(false);
    expect(canTransitionOrder("NEW", "SERVED")).toBe(false);
    expect(canTransitionOrder("READY", "PREPARING")).toBe(false);
    expect(canTransitionOrder("SERVED", "READY")).toBe(false);
  });

  it("allows cancelling only before the order is served", () => {
    for (const from of ["NEW", "ACCEPTED", "PREPARING", "READY"] as const) {
      expect(canTransitionOrder(from, "CANCELLED")).toBe(true);
    }
    expect(canTransitionOrder("SERVED", "CANCELLED")).toBe(false);
  });

  it("treats SERVED and CANCELLED as final", () => {
    for (const to of ORDER_STATUSES) {
      expect(canTransitionOrder("SERVED", to)).toBe(false);
      expect(canTransitionOrder("CANCELLED", to)).toBe(false);
    }
  });

  it("never allows a status to 'transition' to itself", () => {
    for (const status of ORDER_STATUSES) expect(canTransitionOrder(status, status)).toBe(false);
  });

  it("offers one forward action per active status", () => {
    expect(nextPreparationStatus("NEW")).toBe("ACCEPTED");
    expect(nextPreparationStatus("READY")).toBe("SERVED");
    expect(nextPreparationStatus("SERVED")).toBeNull();
    expect(nextPreparationStatus("CANCELLED")).toBeNull();
  });
});

describe("payment status machine", () => {
  it("reaches REFUNDED only through REFUND_PENDING", () => {
    expect(canTransitionPayment("PAID", "REFUNDED")).toBe(false);
    expect(canTransitionPayment("PAID", "REFUND_PENDING")).toBe(true);
    expect(canTransitionPayment("REFUND_PENDING", "REFUNDED")).toBe(true);
  });

  it("lets a rejected refund fall back to PAID", () => {
    expect(canTransitionPayment("REFUND_PENDING", "PAID")).toBe(true);
  });

  it("treats REFUNDED as final", () => {
    for (const to of PAYMENT_STATUSES) expect(canTransitionPayment("REFUNDED", to)).toBe(false);
  });
});

describe("order numbers", () => {
  it.each([
    [1, "SE-001"],
    [42, "SE-042"],
    [999, "SE-999"],
    [1000, "SE-1000"], // must not be truncated to SE-100
    [12345, "SE-12345"],
  ])("formats sequence %i as %s", (sequence, expected) => {
    expect(formatOrderNumber("SE", sequence)).toBe(expected);
  });

  it("rejects invalid prefixes and sequences", () => {
    expect(() => formatOrderNumber("se", 1)).toThrow(RangeError);
    expect(() => formatOrderNumber("TOOLONG", 1)).toThrow(RangeError);
    expect(() => formatOrderNumber("SE", 0)).toThrow(RangeError);
    expect(() => formatOrderNumber("SE", 1.5)).toThrow(RangeError);
  });

  it("parses what it formats, case-insensitively", () => {
    expect(parseOrderNumber("SE-042")).toEqual({ prefix: "SE", sequence: 42 });
    expect(parseOrderNumber(" se-1000 ")).toEqual({ prefix: "SE", sequence: 1000 });
    expect(parseOrderNumber("SE-42")).toBeNull();
    expect(parseOrderNumber("garbage")).toBeNull();
  });
});
