"use client";

import * as React from "react";

import {
  addLine,
  cartCount,
  parseStoredCart,
  removeLine,
  replaceLine,
  serialiseCart,
  setQuantity,
  type CartLimits,
  type CartLine,
  type CartResult,
  type NewLine,
} from "@/lib/customer/cart";

/**
 * The cart lives in this browser (localStorage, one cart per table code) so it survives
 * navigation and refresh with no account. It holds ids and quantities only: names and prices are
 * always re-read from the live menu, and the server re-prices at checkout. If storage is blocked
 * (private mode, policy), it falls back to memory for the life of the page rather than failing.
 */

const EVENT = "se-cart-change";
const memory = new Map<string, string>();
const storageKey = (tableCode: string) => `se-cart-v1:${tableCode}`;

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeRaw(key: string, value: string | null) {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the in-memory copy above keeps the cart working for this visit.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/** While server-rendering (and during hydration) there is no cart yet. */
const NOT_HYDRATED = undefined;

export interface CartApi {
  lines: CartLine[];
  /** False until the browser has read its stored cart; show a skeleton, not "empty". */
  hydrated: boolean;
  count: number;
  limits: CartLimits;
  add: (line: NewLine) => CartResult;
  replace: (oldKey: string, line: NewLine) => CartResult;
  setQty: (key: string, quantity: number) => CartResult;
  remove: (key: string) => void;
  removeMany: (keys: readonly string[]) => void;
  clear: () => void;
  /** Politely announce something to screen-reader and sighted users alike. */
  announce: (message: string) => void;
}

const CartContext = React.createContext<CartApi | null>(null);

export function useCart(): CartApi {
  const ctx = React.useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>");
  return ctx;
}

export function CartProvider({
  tableCode,
  limits,
  children,
}: {
  tableCode: string;
  limits: CartLimits;
  children: React.ReactNode;
}) {
  const key = storageKey(tableCode);
  const raw = React.useSyncExternalStore<string | null | undefined>(
    subscribe,
    () => readRaw(key),
    () => NOT_HYDRATED,
  );
  const hydrated = raw !== NOT_HYDRATED;
  const lines = React.useMemo(() => parseStoredCart(raw ?? null), [raw]);
  const [notice, setNotice] = React.useState("");
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const announce = React.useCallback((message: string) => {
    setNotice(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(""), 3500);
  }, []);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  const { maxItemQuantity, maxItemsPerOrder } = limits;
  const api = React.useMemo<CartApi>(() => {
    const limitsNow = { maxItemQuantity, maxItemsPerOrder };
    const current = () => parseStoredCart(readRaw(key));
    const commit = (result: CartResult): CartResult => {
      if (result.ok) writeRaw(key, result.lines.length ? serialiseCart(result.lines) : null);
      return result;
    };
    return {
      lines,
      hydrated,
      count: cartCount(lines),
      limits: limitsNow,
      add: (line) => commit(addLine(current(), line, limitsNow)),
      replace: (oldKey, line) => commit(replaceLine(current(), oldKey, line, limitsNow)),
      setQty: (lineKeyValue, quantity) =>
        commit(setQuantity(current(), lineKeyValue, quantity, limitsNow)),
      remove: (lineKeyValue) => {
        commit({ ok: true, lines: removeLine(current(), lineKeyValue) });
      },
      removeMany: (keys) => {
        const drop = new Set(keys);
        commit({ ok: true, lines: current().filter((line) => !drop.has(line.key)) });
      },
      clear: () => writeRaw(key, null),
      announce,
    };
  }, [key, lines, hydrated, maxItemQuantity, maxItemsPerOrder, announce]);

  return (
    <CartContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        data-testid="cart-notice"
        className={
          notice
            ? "pointer-events-none fixed inset-x-0 bottom-24 z-40 mx-auto w-fit max-w-[90vw] rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background shadow-card"
            : "sr-only"
        }
      >
        {notice}
      </div>
    </CartContext.Provider>
  );
}
