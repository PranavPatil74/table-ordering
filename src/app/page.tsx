import Link from "next/link";

import { LogoMark } from "@/components/brand/logo-mark";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const steps = [
  {
    title: "Scan",
    body: "Scan the QR code on your table. Your table number appears on its own. There is no app to install and no account to create.",
  },
  {
    title: "Choose",
    body: "Browse the menu at your own pace. Pick your bread, sauces and extras exactly the way you like them.",
  },
  {
    title: "Pay and relax",
    body: "Pay securely on your phone. Your order goes straight to the counter, and you can follow it from received to ready.",
  },
] as const;

export default function Home() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-5 sm:px-8">
      <header className="flex items-center gap-3 py-6">
        <LogoMark />
        <span className="font-display text-2xl font-semibold tracking-tight">Sandwich Express</span>
      </header>

      <main className="flex flex-1 flex-col gap-14 pb-16 sm:gap-20">
        <section
          aria-labelledby="hero-title"
          className="flex max-w-2xl flex-col items-start gap-5 pt-4 sm:pt-10"
        >
          <Badge variant="gold">Dine-in table ordering</Badge>
          <h1 id="hero-title" className="text-4xl leading-[1.1] font-semibold sm:text-6xl">
            Your table is the counter.
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            Order from your seat. Scan the QR code on your table, build your sandwich, and pay on
            your phone. We start making it the moment your payment is confirmed.
          </p>
        </section>

        <section aria-labelledby="how-title" className="flex flex-col gap-6">
          <h2 id="how-title" className="text-2xl font-semibold sm:text-3xl">
            How it works
          </h2>
          <ol className="grid gap-4 sm:grid-cols-3">
            {steps.map((step, index) => (
              <li key={step.title} className="flex">
                <Card className="w-full">
                  <CardHeader>
                    <span
                      aria-hidden="true"
                      className="font-display text-5xl leading-none font-semibold text-accent"
                    >
                      {index + 1}
                    </span>
                    <CardTitle>{step.title}</CardTitle>
                    <CardDescription>{step.body}</CardDescription>
                  </CardHeader>
                </Card>
              </li>
            ))}
          </ol>
        </section>

        <p className="rounded-xl border border-dashed border-input bg-muted px-5 py-4 text-base text-muted-foreground">
          Table ordering is available inside the cafe only. If your table has no QR code, please ask
          at the counter and we will take your order there.
        </p>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t py-6 text-sm text-muted-foreground">
        <span>Sandwich Express. Fresh sandwiches, made to order.</span>
        <Link href="/staff/login" className="underline underline-offset-4 hover:text-foreground">
          Staff sign-in
        </Link>
      </footer>
    </div>
  );
}
