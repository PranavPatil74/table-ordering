"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import type { CatalogGroup, CatalogItem } from "@/lib/customer/catalog";
import { defaultSelection, priceLine, validateSelection } from "@/lib/customer/rules";
import { formatPaise } from "@/lib/money";
import { DIETARY_TAG_LABELS } from "@/lib/menu/validation";

export interface SheetSubmit {
  optionIds: string[];
  quantity: number;
}

const rangeHint = (group: CatalogGroup) => {
  if (group.minSelect >= 1 && group.maxSelect === 1) return "Choose 1";
  if (group.minSelect >= 1) return `Choose ${group.minSelect} to ${group.maxSelect}`;
  return `Optional, up to ${group.maxSelect}`;
};

/**
 * Customisation dialog (native <dialog>: focus is trapped, Escape closes). The same component adds
 * a new line and edits an existing one. Rules and the live total come from the shared customer
 * domain code, so what is shown here is exactly what the server later enforces.
 */
export function ItemSheet({
  item,
  mode,
  initialOptionIds,
  initialQuantity,
  maxQuantity,
  onSubmit,
  onClose,
}: {
  item: CatalogItem | null;
  mode: "add" | "edit";
  initialOptionIds?: string[];
  initialQuantity?: number;
  maxQuantity: number;
  /** Returns an error message to show, or null when the change was accepted. */
  onSubmit: (value: SheetSubmit) => string | null;
  onClose: () => void;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const open = item !== null;

  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={item ? `Customise ${item.name}` : "Customise item"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-2xl border bg-card p-0 text-card-foreground shadow-card backdrop:bg-black/50 sm:m-auto sm:max-w-lg sm:rounded-2xl"
    >
      {item ? (
        <SheetBody
          key={`${item.id}:${(initialOptionIds ?? []).join(",")}:${mode}`}
          item={item}
          mode={mode}
          initialOptionIds={initialOptionIds}
          initialQuantity={initialQuantity}
          maxQuantity={maxQuantity}
          onSubmit={onSubmit}
          onClose={onClose}
        />
      ) : null}
    </dialog>
  );
}

function SheetBody({
  item,
  mode,
  initialOptionIds,
  initialQuantity,
  maxQuantity,
  onSubmit,
  onClose,
}: {
  item: CatalogItem;
  mode: "add" | "edit";
  initialOptionIds?: string[];
  initialQuantity?: number;
  maxQuantity: number;
  onSubmit: (value: SheetSubmit) => string | null;
  onClose: () => void;
}) {
  const [selected, setSelected] = React.useState<string[]>(
    () => initialOptionIds ?? defaultSelection(item),
  );
  const [quantity, setQuantity] = React.useState(initialQuantity ?? 1);
  const [errors, setErrors] = React.useState<string[]>([]);

  const result = validateSelection(item, selected);
  const price = priceLine(
    item,
    result.ok
      ? result.chosen
      : item.groups.flatMap((group) =>
          group.options
            .filter((option) => selected.includes(option.id) && option.isAvailable)
            .map((option) => ({ group, option })),
        ),
    quantity,
  );

  function toggle(group: CatalogGroup, optionId: string, checked: boolean) {
    setErrors([]);
    setSelected((current) => {
      const withoutThis = current.filter((id) => id !== optionId);
      if (!checked) return withoutThis;
      if (group.maxSelect === 1) {
        // A single-choice group swaps its previous pick.
        const others = new Set(group.options.map((o) => o.id));
        return [...withoutThis.filter((id) => !others.has(id)), optionId];
      }
      return [...withoutThis, optionId];
    });
  }

  function submit() {
    if (!result.ok) {
      setErrors(result.problems.map((p) => p.message));
      return;
    }
    const failure = onSubmit({ optionIds: selected, quantity });
    if (failure) setErrors([failure]);
  }

  return (
    <div className="flex flex-col gap-5 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-2xl font-semibold">{item.name}</h2>
          {item.dietaryTags.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {item.dietaryTags.map((tag) => DIETARY_TAG_LABELS[tag] ?? tag).join(" · ")}
            </p>
          ) : null}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          Close
        </Button>
      </div>
      {item.description ? (
        <p className="text-base text-muted-foreground">{item.description}</p>
      ) : null}
      {item.ingredients ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">Ingredients: </span>
          {item.ingredients}
        </p>
      ) : null}

      {item.groups.map((group) => {
        const count = group.options.filter((o) => selected.includes(o.id)).length;
        const single = group.maxSelect === 1;
        const atMax = count >= group.maxSelect;
        return (
          <fieldset
            key={group.id}
            className="flex flex-col gap-2"
            data-testid={`group-${group.id}`}
          >
            <legend className="mb-1 flex w-full items-baseline justify-between gap-3">
              <span className="text-lg font-semibold">{group.name}</span>
              <span className="text-sm text-muted-foreground">{rangeHint(group)}</span>
            </legend>
            {group.options.map((option) => {
              const checked = selected.includes(option.id);
              const disabled = !option.isAvailable || (!single && !checked && atMax);
              return (
                <label
                  key={option.id}
                  className={`flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2 ${
                    disabled ? "opacity-60" : "cursor-pointer hover:bg-muted"
                  } ${checked ? "border-primary bg-secondary" : "border-border"}`}
                >
                  <input
                    type={single ? "radio" : "checkbox"}
                    name={group.id}
                    value={option.id}
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => toggle(group, option.id, event.target.checked)}
                    className="size-5 accent-[var(--primary)]"
                  />
                  <span className="flex-1">
                    {option.name}
                    {!option.isAvailable ? (
                      <span className="ml-2 text-sm text-muted-foreground">Sold out</span>
                    ) : null}
                  </span>
                  {option.priceDeltaPaise > 0 ? (
                    <span className="text-sm text-muted-foreground">
                      +{formatPaise(option.priceDeltaPaise)}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </fieldset>
        );
      })}

      <div className="flex items-center justify-between gap-4">
        <span className="font-semibold">Quantity</span>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Decrease quantity"
            disabled={quantity <= 1}
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
          >
            −
          </Button>
          <output
            aria-live="polite"
            className="w-8 text-center text-lg font-semibold"
            data-testid="sheet-quantity"
          >
            {quantity}
          </output>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Increase quantity"
            disabled={quantity >= maxQuantity}
            onClick={() => setQuantity((q) => Math.min(maxQuantity, q + 1))}
          >
            +
          </Button>
        </div>
      </div>

      {errors.length > 0 ? (
        <ul
          role="alert"
          className="rounded-lg border border-destructive bg-card p-3 text-sm text-destructive"
        >
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      <Button type="button" size="lg" onClick={submit} data-testid="sheet-submit">
        {mode === "edit" ? "Update item" : "Add to cart"} · {formatPaise(price.totalPaise)}
      </Button>
    </div>
  );
}
