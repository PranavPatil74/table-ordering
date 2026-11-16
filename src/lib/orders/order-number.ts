/**
 * Human-friendly order numbers: SE-001, SE-042, SE-1000.
 *
 * Numbers restart each business day (Asia/Kolkata) and are unique per (business_date,
 * order_number). The database generates them atomically; this mirror is for display and
 * parsing. Note: String.prototype.padStart never truncates, unlike SQL lpad().
 */
export function formatOrderNumber(prefix: string, sequence: number): string {
  if (!/^[A-Z]{1,5}$/.test(prefix)) {
    throw new RangeError("Order number prefix must be 1 to 5 capital letters");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError("Order sequence must be a positive integer");
  }
  return `${prefix}-${String(sequence).padStart(3, "0")}`;
}

const ORDER_NUMBER_PATTERN = /^([A-Z]{1,5})-(\d{3,})$/;

export function parseOrderNumber(value: string): { prefix: string; sequence: number } | null {
  const match = ORDER_NUMBER_PATTERN.exec(value.trim().toUpperCase());
  if (!match) return null;
  return { prefix: match[1] as string, sequence: Number(match[2]) };
}
