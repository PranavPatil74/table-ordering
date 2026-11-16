/**
 * Money is ALWAYS an integer number of paise (1 INR = 100 paise). Floating-point rupees are
 * never stored, summed or sent to the payment gateway: `19.99 * 100` is `1998.9999999999998`
 * in JavaScript, which is exactly the kind of error that makes a payment amount mismatch.
 *
 * Floating-point division appears in exactly one place, `formatPaise`, and only for display.
 */

/** Throws unless `value` is a safe integer. Use at every boundary that accepts an amount. */
export function assertPaise(value: number, label = "amount"): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a whole number of paise, received ${String(value)}`);
  }
}

/**
 * Parse a rupee amount typed by a human ("249", "249.5", "249.50") into paise using string
 * arithmetic only. Rejects negatives, more than two decimals, separators and exponents.
 */
export function parseRupeesToPaise(input: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) {
    throw new RangeError("Enter an amount like 249 or 249.50");
  }
  const rupees = Number(match[1]);
  const paise = Number((match[2] ?? "").padEnd(2, "0"));
  return rupees * 100 + paise;
}

/** Sum integer paise amounts, validating every term. */
export function sumPaise(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    assertPaise(value, "line amount");
    total += value;
  }
  assertPaise(total, "total");
  return total;
}

/** Display formatting using Indian digit grouping: 12345600 -> "₹1,23,456", 24950 -> "₹249.50". */
export function formatPaise(paise: number): string {
  assertPaise(paise);
  const hasFraction = paise % 100 !== 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}
