import type { Metadata } from "next";

import { CustomerPage } from "@/components/customer/customer-page";
import { MenuView } from "@/components/customer/menu-view";

export const metadata: Metadata = { title: "Menu", robots: { index: false } };

export default async function MenuPage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string | string[] }>;
}) {
  const { table } = await searchParams;
  return (
    <CustomerPage
      table={table}
      path="/menu"
      render={({ catalog, settings, tableCode }) => (
        <MenuView catalog={catalog} settings={settings} tableCode={tableCode} />
      )}
    />
  );
}
