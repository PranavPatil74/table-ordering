"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";

export interface ConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
  /** Destructive confirmations use the red button. */
  destructive?: boolean;
}

/**
 * A modal confirmation built on the native <dialog>: the browser traps focus inside, Escape
 * cancels, and focus returns to the button that opened it. Focus starts on "Cancel", so pressing
 * Enter by reflex never confirms a destructive action.
 */
export function ConfirmDialog({
  open,
  copy,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  copy: ConfirmCopy;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();

  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(92vw,28rem)] rounded-xl border bg-card p-6 text-card-foreground shadow-card backdrop:bg-black/50"
    >
      {open ? (
        <div className="flex flex-col gap-4">
          <h2 id={titleId} className="font-display text-xl font-semibold">
            {copy.title}
          </h2>
          <p id={descriptionId} className="text-base text-muted-foreground">
            {copy.description}
          </p>
          <div className="flex flex-wrap justify-end gap-3">
            <Button type="button" variant="outline" autoFocus onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={copy.destructive ? "destructive" : "default"}
              onClick={onConfirm}
              disabled={pending}
            >
              {copy.confirmLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
