import type { QrContext } from "@/lib/tables/qr-context";

/** Explains what the QR codes point at, and warns when that address will not work for customers. */
export function QrNotice({ context }: { context: QrContext }) {
  const { info, policy } = context;
  if (info.kind === "public" && !policy.reason) {
    return (
      <p className="text-base text-muted-foreground print:hidden">
        QR codes open <strong className="text-foreground">{info.origin}</strong>.
      </p>
    );
  }
  return (
    <div
      role={policy.canExport ? "status" : "alert"}
      className="rounded-xl border border-destructive bg-destructive/5 px-4 py-3 text-base print:hidden"
    >
      <p className="font-semibold text-destructive">
        {policy.canExport ? "Test QR codes only" : "QR download and printing are turned off"}
      </p>
      <p>{policy.reason}</p>
    </div>
  );
}
