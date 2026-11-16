"use client";

import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useActionState, useId, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { validateLogin, type LoginFieldErrors } from "@/lib/auth/login";

import { signInAction } from "./actions";
import { initialLoginState } from "./state";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending} aria-disabled={pending}>
      {pending ? (
        <>
          <LoaderCircle className="animate-spin" aria-hidden="true" />
          Signing in…
        </>
      ) : (
        "Sign in"
      )}
    </Button>
  );
}

export function LoginForm({ next }: { next?: string | undefined }) {
  const [state, formAction] = useActionState(signInAction, initialLoginState);
  const [clientErrors, setClientErrors] = useState<LoginFieldErrors | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const ids = { email: useId(), password: useId(), emailError: useId(), passwordError: useId() };

  // Client-side checks only save a round trip; the server action validates again.
  const fieldErrors = clientErrors ?? state.fieldErrors ?? {};

  return (
    <form
      action={formAction}
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        const data = new FormData(event.currentTarget);
        const result = validateLogin({ email: data.get("email"), password: data.get("password") });
        if (!result.ok) {
          event.preventDefault();
          setClientErrors(result.fieldErrors);
        } else {
          setClientErrors(null);
        }
      }}
    >
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state.status === "error" && state.message ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive bg-card px-4 py-3 text-sm font-medium text-destructive"
        >
          {state.message}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor={ids.email}>Email</Label>
        <Input
          id={ids.email}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={state.email ?? ""}
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby={fieldErrors.email ? ids.emailError : undefined}
          placeholder="name@example.com"
        />
        {fieldErrors.email ? (
          <p id={ids.emailError} className="text-sm font-medium text-destructive">
            {fieldErrors.email}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={ids.password}>Password</Label>
        <div className="relative">
          <Input
            id={ids.password}
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
            className="pr-12"
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={fieldErrors.password ? ids.passwordError : undefined}
          />
          <button
            type="button"
            onClick={() => setShowPassword((shown) => !shown)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-0 flex w-11 cursor-pointer items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground"
          >
            {showPassword ? (
              <EyeOff className="size-5" aria-hidden="true" />
            ) : (
              <Eye className="size-5" aria-hidden="true" />
            )}
          </button>
        </div>
        {fieldErrors.password ? (
          <p id={ids.passwordError} className="text-sm font-medium text-destructive">
            {fieldErrors.password}
          </p>
        ) : null}
      </div>

      <SubmitButton />
    </form>
  );
}
