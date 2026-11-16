"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button, type ButtonProps } from "@/components/ui/button";
import type { ActionResult } from "@/lib/forms";

import { ConfirmDialog, type ConfirmCopy } from "./confirm-dialog";
import { useFeedback } from "./feedback";

/**
 * A button that runs a (bound) Server Action, optionally behind a confirmation, and reports the
 * outcome through the shared announcer. The action itself re-checks the caller on the server; this
 * component is only the trigger.
 */
export function ActionButton({
  action,
  confirm,
  children,
  variant = "outline",
  size = "sm",
  onDone,
  ...rest
}: Omit<ButtonProps, "onClick" | "type" | "formAction"> & {
  action: () => Promise<ActionResult>;
  confirm?: ConfirmCopy;
  onDone?: (result: ActionResult) => void;
}) {
  const feedback = useFeedback();
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [asking, setAsking] = React.useState(false);

  const run = () => {
    setAsking(false);
    startTransition(async () => {
      let result: ActionResult;
      try {
        result = await action();
      } catch {
        result = { ok: false, message: "Something went wrong. Nothing was changed. Try again." };
      }
      feedback.report(result);
      onDone?.(result);
      if (result.ok) router.refresh();
    });
  };

  return (
    <>
      <Button
        {...rest}
        type="button"
        variant={variant}
        size={size}
        disabled={pending || rest.disabled}
        aria-busy={pending || undefined}
        onClick={() => (confirm ? setAsking(true) : run())}
      >
        {children}
      </Button>
      {confirm ? (
        <ConfirmDialog
          open={asking}
          copy={confirm}
          pending={pending}
          onConfirm={run}
          onCancel={() => setAsking(false)}
        />
      ) : null}
    </>
  );
}
