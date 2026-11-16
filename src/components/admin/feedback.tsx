"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/forms";

interface Message {
  kind: "success" | "error";
  text: string;
  key: number;
}

interface Feedback {
  report: (result: ActionResult) => void;
}

const FeedbackContext = React.createContext<Feedback | null>(null);

/** Auto-dismiss successes; keep errors until the person closes them. */
const SUCCESS_MS = 4_000;

/**
 * One place where the result of an inline action ("Marked sold out.", "Couldn't save...") is
 * announced to everyone, including screen-reader users: successes politely (role=status), errors
 * assertively (role=alert).
 */
export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = React.useState<Message | null>(null);
  const counter = React.useRef(0);

  const report = React.useCallback((result: ActionResult) => {
    counter.current += 1;
    setMessage({
      kind: result.ok ? "success" : "error",
      text: result.message,
      key: counter.current,
    });
  }, []);

  React.useEffect(() => {
    if (message?.kind !== "success") return;
    const timer = setTimeout(() => setMessage(null), SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [message]);

  const value = React.useMemo(() => ({ report }), [report]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 print:hidden">
        {/* Both live regions always exist so announcements are reliable. */}
        <div role="status" aria-live="polite" className="contents">
          {message?.kind === "success" ? (
            <p
              key={message.key}
              className="pointer-events-auto rounded-lg border border-border bg-foreground px-4 py-3 text-base font-medium text-background shadow-card"
            >
              {message.text}
            </p>
          ) : null}
        </div>
        <div role="alert" className="contents">
          {message?.kind === "error" ? (
            <div
              key={message.key}
              className="pointer-events-auto flex max-w-xl items-start gap-3 rounded-lg border border-destructive bg-card px-4 py-3 text-base text-destructive shadow-card"
            >
              <p className="font-medium">{message.text}</p>
              <Button size="sm" variant="outline" onClick={() => setMessage(null)}>
                Dismiss
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): Feedback {
  const context = React.useContext(FeedbackContext);
  // Outside a provider (a unit test, say) fall back to doing nothing rather than crashing.
  return context ?? { report: () => undefined };
}
