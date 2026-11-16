import type { Metadata } from "next";

import { CheckoutView } from "@/components/customer/checkout-view";
import { CustomerPage } from "@/components/customer/customer-page";

export const metadata: Metadata = { title: "Checkout", robots: { index: false } };

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string | string[] }>;
}) {
  const { table } = await searchParams;
  return (
    <CustomerPage
      table={table}
      path="/checkout"
      render={({ catalog, settings, tableCode, tableLabel }) => (
        <CheckoutView
          catalog={catalog}
          settings={settings}
          tableCode={tableCode}
          tableLabel={tableLabel}
        />
      )}
    />
  );
}
