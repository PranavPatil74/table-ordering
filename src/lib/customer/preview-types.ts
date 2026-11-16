import type { LineStatus } from "./pricing";

/** Types and constants shared by the checkout screen (browser) and the server verdict. No server code. */
/** Phase 4 never takes payment. Phase 5 replaces this with the real gateway state. */
export type PaymentState = "not_configured";
export const PAYMENT_STATE: PaymentState = "not_configured";

export interface PreviewLine {
  key: string;
  status: LineStatus;
  problems: string[];
  name: string | null;
  options: string[];
  quantity: number;
  eachPaise: number | null;
  totalPaise: number | null;
}

export type PreviewResult =
  | {
      status: "ready";
      submissionId: string;
      table: { code: string; label: string };
      lines: PreviewLine[];
      totalPaise: number;
      /** SHA-256 of the exact snapshot a payment would be created from. */
      fingerprint: string;
      payment: PaymentState;
    }
  | {
      status: "needs_attention";
      lines: PreviewLine[];
      totalPaise: number;
      blockers: string[];
    }
  | { status: "table_problem"; title: string; body: string }
  | { status: "invalid_input"; message: string }
  | { status: "busy"; message: string }
  | { status: "error"; message: string };
