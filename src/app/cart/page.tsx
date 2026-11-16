import type { Metadata } from "next";

import { CartView } from "@/components/customer/cart-view";
import { CustomerPage } from "@/components/customer/customer-page";

export const metadata: Metadata = { title: "Your cart", robots: { index: false } };

export default async function CartPage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string | string[] }>;
}) {
  const { table } = await searchParams;
  return (
    <CustomerPage
      table={table}
      path="/cart"
      render={({ catalog, settings, tableCode }) => (
        <CartView catalog={catalog} settings={settings} tableCode={tableCode} />
      )}
    />
  );
}
