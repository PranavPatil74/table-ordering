"use client";

import Link from "next/link";
import * as React from "react";

import { loadSavedCheckoutAction, saveCheckoutAction } from "@/app/checkout/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CafeSettings, Catalog } from "@/lib/customer/catalog";
import { priceCart } from "@/lib/customer/pricing";
import type { SaveCheckoutResult, SavedCheckout } from "@/lib/customer/checkout-types";
import { CUSTOMER_NAME_MAX, SPECIAL_INSTRUCTIONS_MAX } from "@/lib/customer/snapshot";
import { formatPaise } from "@/lib/money";

import { useCart } from "./cart-provider";

const STORAGE_PREFIX = "se-checkout:";

/** What this tab remembers so a reload or a retry reuses the SAME submission id (the idempotency key). */
interface StoredSubmission {
  id: string;
  signature: string;
}

function readStored(tableCode: string): StoredSubmission | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + tableCode);
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredSubmission>) : null;
    return parsed && typeof parsed.id === "string" && typeof parsed.signature === "string"
      ? { id: parsed.id, signature: parsed.signature }
      : null;
  } catch {
    return null;
  }
}

function writeStored(tableCode: string, value: StoredSubmission | null) {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_PREFIX + tableCode, JSON.stringify(value));
    else window.sessionStorage.removeItem(STORAGE_PREFIX + tableCode);
  } catch {
    // Private mode or blocked storage: saving still works, a reload just starts a new submission.
  }
}

type NotSaved = Exclude<SaveCheckoutResult, { status: "saved" }>;

/**
 * Checkout, Phase 5: the server re-prices the cart from the live menu and SAVES it (one pending
 * payment attempt per submission id, safe to repeat). Saving is not paying and not ordering. No
 * payment can be taken yet, and this screen says so plainly instead of pretending. It never shows
 * an order number or a "payment successful" state, because none exists.
 */
export function CheckoutView({
  catalog,
  settings,
  tableCode,
  tableLabel,
}: {
  catalog: Catalog;
  settings: CafeSettings;
  tableCode: string;
  tableLabel: string;
}) {
  const cart = useCart();
  const [name, setName] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [saved, setSaved] = React.useState<{
    signature: string;
    value: SavedCheckout;
    replay: boolean;
  } | null>(null);
  const [problem, setProblem] = React.useState<{ signature: string; value: NotSaved } | null>(null);
  const [pending, startTransition] = React.useTransition();
  const inFlight = React.useRef(false);
  const restored = React.useRef(false);

  const pricing = React.useMemo(
    () => priceCart(catalog, settings, cart.lines),
    [catalog, settings, cart.lines],
  );
  const signature = JSON.stringify([
    cart.lines.map((l) => [l.key, l.quantity, l.optionIds]),
    name,
    notes,
  ]);
  const freshSaved = saved && saved.signature === signature ? saved : null;
  const savedIsStale = saved !== null && freshSaved === null;
  const freshProblem = problem && problem.signature === signature ? problem.value : null;
  const cartHref = `/cart?table=${encodeURIComponent(tableCode)}`;

  // Coming back to this screen (reload, back button): show the checkout this tab already saved.
  React.useEffect(() => {
    if (!cart.hydrated || restored.current) return;
    restored.current = true;
    const stored = readStored(tableCode);
    if (!stored) return;
    void loadSavedCheckoutAction({ tableCode, submissionId: stored.id })
      .then((result) => {
        if (result.status === "saved") {
          setSaved({ signature: stored.signature, value: result, replay: true });
        } else if (result.status === "not_found") {
          writeStored(tableCode, null);
        }
      })
      .catch(() => {
        // Offline on return: the saved checkout is still safe on the server; the customer can retry.
      });
  }, [cart.hydrated, tableCode]);

  if (!cart.hydrated) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading your order…
      </p>
    );
  }
  if (cart.lines.length === 0) {
    return (
      <section
        className="flex flex-col items-center gap-4 rounded-xl border bg-card p-8 text-center"
        data-testid="checkout-empty"
      >
        <h1 className="text-2xl font-semibold">There&apos;s nothing to check out</h1>
        <p className="text-muted-foreground">Your cart is empty.</p>
        <Button asChild>
          <Link href={`/menu?table=${encodeURIComponent(tableCode)}`}>Browse the menu</Link>
        </Button>
      </section>
    );
  }

  function save() {
    if (inFlight.current) return; // a double tap must not send two requests
    inFlight.current = true;
    const sent = signature;
    // Same cart and notes as the last attempt: reuse its id, so a retry cannot create a second
    // payment attempt. Anything different gets a new id (the old one is bound to the old cart).
    const stored = readStored(tableCode);
    const submission: StoredSubmission =
      stored && stored.signature === sent ? stored : { id: crypto.randomUUID(), signature: sent };
    writeStored(tableCode, submission);
    setProblem(null);
    startTransition(async () => {
      try {
        const value = await saveCheckoutAction({
          tableCode,
          submissionId: submission.id,
          customerName: name,
          specialInstructions: notes,
          lines: cart.lines.map(({ menuItemId, optionIds, quantity }) => ({
            menuItemId,
            optionIds,
            quantity,
          })),
        });
        if (value.status === "saved") {
          setSaved({ signature: sent, value, replay: value.replay });
        } else {
          if (value.status === "conflict" || value.status === "needs_attention") {
            writeStored(tableCode, null); // the next save starts a fresh submission
          }
          setProblem({ signature: sent, value });
        }
      } catch {
        // The request may or may not have reached the server. The stored id is kept, so pressing
        // "Try again" is safe: the server returns the existing checkout instead of making a second.
        setProblem({
          signature: sent,
          value: {
            status: "error",
            message:
              "We couldn't reach the server. Please check your connection and try again. You won't be charged twice.",
          },
        });
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <>
      <h1 className="text-3xl font-semibold">Checkout</h1>
      <p className="text-muted-foreground">
        Table: <span className="font-semibold text-foreground">{tableLabel}</span>
      </p>

      <section
        aria-label="Order summary"
        className="flex flex-col gap-2 rounded-xl border bg-card p-4"
      >
        <ul className="flex flex-col gap-2">
          {pricing.lines.map((line) => (
            <li
              key={line.key}
              className="flex items-start justify-between gap-3"
              data-testid="checkout-line"
            >
              <span>
                {line.quantity} × {line.item?.name ?? "Unavailable item"}
                {line.chosen.length > 0 ? (
                  <span className="block text-sm text-muted-foreground">
                    {line.chosen.map((c) => c.option.name).join(", ")}
                  </span>
                ) : null}
                {line.status !== "ok" ? (
                  <span className="block text-sm text-destructive">{line.problems[0]}</span>
                ) : null}
              </span>
              <span className="shrink-0">
                {line.price ? formatPaise(line.price.totalPaise) : "—"}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-baseline justify-between border-t pt-3">
          <span className="font-semibold">Total</span>
          <span className="text-xl font-semibold" data-testid="checkout-total">
            {formatPaise(pricing.totalPaise)}
          </span>
        </div>
        <Link
          href={cartHref}
          className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
        >
          Change items
        </Link>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="customer-name" className="font-semibold">
            Your name <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Input
            id="customer-name"
            value={name}
            maxLength={CUSTOMER_NAME_MAX}
            autoComplete="given-name"
            onChange={(event) => setName(event.target.value)}
          />
          <p className="text-sm text-muted-foreground">
            So we can call your name when it&apos;s ready.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="special-instructions" className="font-semibold">
            Anything we should know?{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Textarea
            id="special-instructions"
            value={notes}
            maxLength={SPECIAL_INSTRUCTIONS_MAX}
            rows={3}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </section>

      {!pricing.canCheckout ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-destructive bg-card p-4"
          data-testid="checkout-blocked"
        >
          {pricing.blockers.map((b) => (
            <p key={b} className="text-destructive">
              {b}
            </p>
          ))}
          <Button asChild variant="outline" size="sm" className="self-start">
            <Link href={cartHref}>Back to cart</Link>
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="lg"
          onClick={save}
          disabled={pending}
          aria-busy={pending}
          data-testid="save-checkout"
        >
          {pending
            ? "Saving your checkout…"
            : freshSaved
              ? "Checkout saved"
              : `Save checkout · ${formatPaise(pricing.totalPaise)}`}
        </Button>
      )}

      {savedIsStale ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="checkout-stale">
          Your order changed after it was saved. Save it again to keep the latest version. The
          earlier save is not paid for and will simply expire.
        </p>
      ) : null}

      <div aria-live="polite" className="flex flex-col gap-4">
        {freshSaved ? (
          <SavedPanel value={freshSaved.value} replay={freshSaved.replay} cartHref={cartHref} />
        ) : null}
        {freshProblem ? (
          <Problem value={freshProblem} cartHref={cartHref} onRetry={save} pending={pending} />
        ) : null}
      </div>
    </>
  );
}

const STAGE_COPY = {
  saved: {
    title: "Checkout saved",
    lead: "Your order details are saved. This is not an order yet and you have not been charged.",
  },
  payment_verified: {
    title: "Payment verified",
    lead: "Your payment was verified. The cafe is about to receive your order.",
  },
  order_created: {
    title: "Order placed",
    lead: "The cafe has your order.",
  },
  closed: {
    title: "This saved checkout has expired",
    lead: "Nothing was charged for it. Review your order and save it again to continue.",
  },
} as const;

function SavedPanel({
  value,
  replay,
  cartHref,
}: {
  value: SavedCheckout;
  replay: boolean;
  cartHref: string;
}) {
  const copy = STAGE_COPY[value.stage];
  const paymentStarted = value.stage === "payment_verified" || value.stage === "order_created";
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-primary bg-card p-4"
      data-testid="checkout-saved"
      data-stage={value.stage}
    >
      <h2 className="text-xl font-semibold">{copy.title}</h2>
      <p>{copy.lead}</p>
      {replay && value.stage === "saved" ? (
        <p className="text-sm text-muted-foreground" data-testid="checkout-replay">
          This is the checkout you saved earlier. Nothing new was created.
        </p>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Reference</dt>
        <dd className="font-mono font-semibold" data-testid="saved-reference">
          {value.reference}
        </dd>
        <dt className="text-muted-foreground">Table</dt>
        <dd>{value.table.label}</dd>
        <dt className="text-muted-foreground">Verified total</dt>
        <dd className="font-semibold" data-testid="saved-total">
          {formatPaise(value.totalPaise)}
        </dd>
      </dl>

      <ul className="flex flex-col gap-1 border-t pt-3 text-sm">
        {value.lines.map((line) => (
          <li key={line.key} className="flex justify-between gap-3" data-testid="saved-line">
            <span>
              {line.quantity} × {line.name}
              {line.options.length > 0 ? (
                <span className="block text-muted-foreground">{line.options.join(", ")}</span>
              ) : null}
            </span>
            <span className="shrink-0">
              {line.totalPaise !== null ? formatPaise(line.totalPaise) : "—"}
            </span>
          </li>
        ))}
      </ul>

      <ol className="flex flex-col gap-2 border-t pt-3 text-sm" aria-label="Progress">
        <li data-testid="stage-checkout">
          <span className="font-semibold">Checkout:</span> saved
        </li>
        <li data-testid="stage-payment">
          <span className="font-semibold">Payment:</span>{" "}
          {value.stage === "closed"
            ? "not taken"
            : paymentStarted
              ? "verified"
              : "not started. Online payment isn't available yet."}
        </li>
        <li data-testid="stage-order">
          <span className="font-semibold">Order:</span>{" "}
          {value.stage === "order_created" ? "placed" : "not placed yet"}
        </li>
      </ol>

      {value.stage === "saved" ? (
        <div
          role="status"
          className="rounded-lg border border-gold bg-secondary p-3"
          data-testid="payment-not-configured"
        >
          <p className="font-semibold">Online payment isn&apos;t switched on yet.</p>
          <p className="text-sm text-muted-foreground">
            Your checkout is saved, but we can&apos;t take payment from this screen, so your order
            has not been placed and you haven&apos;t been charged. Please tell a member of staff
            you&apos;d like to order and quote reference {value.reference}.
          </p>
        </div>
      ) : null}

      {value.stage === "closed" ? (
        <Button asChild variant="outline" className="self-start">
          <Link href={cartHref}>Back to cart</Link>
        </Button>
      ) : null}
    </section>
  );
}

function Problem({
  value,
  cartHref,
  onRetry,
  pending,
}: {
  value: NotSaved;
  cartHref: string;
  onRetry: () => void;
  pending: boolean;
}) {
  switch (value.status) {
    case "needs_attention":
      return (
        <section
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-destructive bg-card p-4"
          data-testid="preview-attention"
        >
          <h2 className="text-xl font-semibold">Some things changed</h2>
          <p>Nothing was saved and you haven&apos;t been charged.</p>
          {value.blockers.map((b) => (
            <p key={b}>{b}</p>
          ))}
          <ul className="list-disc pl-5 text-sm text-destructive">
            {value.lines
              .filter((l) => l.problems.length > 0)
              .map((l) => (
                <li key={l.key}>
                  {l.name ?? "An item"}: {l.problems[0]}
                </li>
              ))}
          </ul>
          <Button asChild variant="outline" className="self-start">
            <Link href={cartHref}>Fix my cart</Link>
          </Button>
        </section>
      );
    case "table_problem":
      return (
        <section
          role="alert"
          className="rounded-xl border border-destructive bg-card p-4"
          data-testid="preview-table-problem"
        >
          <h2 className="text-xl font-semibold">{value.title}</h2>
          <p>{value.body}</p>
        </section>
      );
    case "conflict":
      return (
        <section
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-destructive bg-card p-4"
          data-testid="checkout-conflict"
        >
          <h2 className="text-xl font-semibold">Your order changed</h2>
          <p>{value.message}</p>
          <Button type="button" className="self-start" onClick={onRetry} disabled={pending}>
            Save the latest order
          </Button>
        </section>
      );
    default:
      return (
        <section
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-destructive bg-card p-4"
          data-testid="preview-error"
        >
          <p>{value.message}</p>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={onRetry}
            disabled={pending}
          >
            Try again
          </Button>
        </section>
      );
  }
}
