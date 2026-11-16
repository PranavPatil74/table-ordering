"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/forms";
import { cn } from "@/lib/utils";

import { useFeedback } from "./feedback";

type FormAction = (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;

interface FormContextValue {
  errors: Record<string, string>;
  pending: boolean;
}
const FormContext = React.createContext<FormContextValue>({ errors: {}, pending: false });

/**
 * A form wired to a Server Action. It submits through a transition instead of the `action`
 * prop on purpose: React resets uncontrolled inputs after every `action` submission, which would
 * wipe what the manager typed whenever validation fails. Here the fields keep their values on an
 * error and are cleared only after a successful save (when `resetOnSuccess` is set).
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
  onSuccess,
  label,
}: {
  action: FormAction;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  onSuccess?: (result: Extract<ActionResult, { ok: true }>) => void;
  /** Accessible name of the form. */
  label: string;
}) {
  const feedback = useFeedback();
  const formRef = React.useRef<HTMLFormElement>(null);
  const [result, setResult] = React.useState<ActionResult | null>(null);
  const [pending, startTransition] = React.useTransition();
  const summaryRef = React.useRef<HTMLDivElement>(null);

  const errors = result && !result.ok ? (result.fieldErrors ?? {}) : {};

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    startTransition(async () => {
      let outcome: ActionResult;
      try {
        outcome = await action(result, data);
      } catch (error) {
        // Server Actions that call redirect() throw a framework signal: let it through.
        if (
          error instanceof Error &&
          /NEXT_REDIRECT/.test(`${error.message}${(error as { digest?: string }).digest ?? ""}`)
        ) {
          throw error;
        }
        outcome = { ok: false, message: "Something went wrong. Nothing was saved. Try again." };
      }
      setResult(outcome);
      if (outcome.ok) {
        feedback.report(outcome);
        if (resetOnSuccess) form.reset();
        onSuccess?.(outcome);
      } else {
        // Move attention to the problem so keyboard and screen-reader users notice it.
        queueMicrotask(() => summaryRef.current?.focus());
      }
    });
  };

  return (
    <FormContext.Provider value={{ errors, pending }}>
      <form
        ref={formRef}
        onSubmit={submit}
        aria-label={label}
        noValidate
        className={cn("flex flex-col gap-5", className)}
      >
        <div
          ref={summaryRef}
          tabIndex={-1}
          role={result && !result.ok ? "alert" : undefined}
          className="outline-none"
        >
          {result && !result.ok ? (
            <p className="rounded-lg border border-destructive bg-destructive/5 px-4 py-3 text-base font-medium text-destructive">
              {result.message}
            </p>
          ) : null}
        </div>
        {children}
      </form>
    </FormContext.Provider>
  );
}

export function SubmitButton({
  children,
  pendingLabel = "Saving…",
  ...props
}: Omit<ButtonProps, "type"> & { pendingLabel?: string }) {
  const { pending } = React.useContext(FormContext);
  const status = useFormStatus();
  const busy = pending || status.pending;
  return (
    <Button
      {...props}
      type="submit"
      disabled={busy || props.disabled}
      aria-busy={busy || undefined}
    >
      {busy ? pendingLabel : children}
    </Button>
  );
}

/** Label + control + hint + error, wired together for assistive technology. */
export function Field({
  name,
  label,
  hint,
  required,
  children,
  className,
}: {
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  /** Receives the props the control needs (id, aria-*). */
  children: (props: {
    id: string;
    name: string;
    "aria-invalid": true | undefined;
    "aria-describedby": string | undefined;
    "aria-required": true | undefined;
  }) => React.ReactNode;
  className?: string;
}) {
  const { errors } = React.useContext(FormContext);
  const base = React.useId();
  const id = `${base}-${name}`;
  const error = errors[name];
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children({
        id,
        name,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": [hintId, errorId].filter(Boolean).join(" ") || undefined,
        "aria-required": required ? true : undefined,
      })}
      {hint ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm font-semibold text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Convenience: a plain text input field. */
export function TextField({
  name,
  label,
  hint,
  required,
  ...inputProps
}: { name: string; label: string; hint?: string; required?: boolean } & Omit<
  React.ComponentProps<typeof Input>,
  "name" | "id"
>) {
  return (
    <Field name={name} label={label} hint={hint} required={required}>
      {(fieldProps) => <Input {...fieldProps} {...inputProps} />}
    </Field>
  );
}

/** A labelled multi-line field. Takes only plain props, so server components can render it. */
export function TextAreaField({
  name,
  label,
  hint,
  required,
  ...textareaProps
}: { name: string; label: string; hint?: string; required?: boolean } & Omit<
  React.ComponentProps<typeof Textarea>,
  "name" | "id"
>) {
  return (
    <Field name={name} label={label} hint={hint} required={required}>
      {(fieldProps) => <Textarea {...fieldProps} {...textareaProps} />}
    </Field>
  );
}

/** A labelled drop-down. Options are plain data so server components can render it. */
export function SelectField({
  name,
  label,
  hint,
  required,
  options,
  ...selectProps
}: {
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  options: readonly { value: string; label: string }[];
} & Omit<React.ComponentProps<typeof Select>, "name" | "id" | "children">) {
  return (
    <Field name={name} label={label} hint={hint} required={required}>
      {(fieldProps) => (
        <Select {...fieldProps} {...selectProps}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/** A labelled checkbox. */
export function CheckField({
  name,
  label,
  hint,
  defaultChecked,
  value,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
  value?: string;
}) {
  const id = React.useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        name={name}
        value={value ?? "on"}
        defaultChecked={defaultChecked}
        aria-describedby={hintId}
        className="mt-1 size-5 shrink-0 accent-primary"
      />
      <div className="flex flex-col">
        <Label htmlFor={id} className="text-base leading-snug font-medium">
          {label}
        </Label>
        {hint ? (
          <p id={hintId} className="text-sm text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
