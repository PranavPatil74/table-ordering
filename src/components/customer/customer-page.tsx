import { CustomerStatusPage } from "@/components/customer/status-page";
import { CustomerShell } from "@/components/customer/customer-shell";
import type { CafeSettings, Catalog } from "@/lib/customer/catalog";
import { loadCustomerPage } from "@/lib/customer/page-data";

type Ready = { tableCode: string; tableLabel: string; catalog: Catalog; settings: CafeSettings };

/**
 * Wraps a customer page: validates the table on the server, loads the live menu, and renders
 * either a clear problem page or the shell around `render(...)`. `render` receives plain data and
 * returns a React node, but it runs on the server, so functions are never sent to the browser.
 */
export async function CustomerPage({
  table,
  path,
  render,
}: {
  table: unknown;
  path: "/menu" | "/cart" | "/checkout";
  render: (data: Ready) => React.ReactNode;
}) {
  const data = await loadCustomerPage(table);
  const code = Array.isArray(table) ? table[0] : table;
  const retryHref =
    typeof code === "string" ? `${path}?table=${encodeURIComponent(code)}` : undefined;

  switch (data.kind) {
    case "no_table":
      return (
        <CustomerStatusPage
          testId="no-table"
          title="Scan the QR code on your table"
          body="Open the camera on your phone and point it at the QR code on your table to see the menu and order."
        />
      );
    case "table_problem":
      return (
        <CustomerStatusPage
          testId="table-problem"
          title={data.title}
          body={data.body}
          retryHref={data.retry ? retryHref : undefined}
        />
      );
    case "menu_error":
      return (
        <CustomerStatusPage
          testId="menu-error"
          title="We couldn't load the menu"
          body="Something went wrong on our side. Please try again in a moment."
          retryHref={retryHref}
        />
      );
    case "ready":
      return (
        <CustomerShell
          cafeName={data.settings.cafeName}
          tableCode={data.table.code}
          tableLabel={data.table.label}
          limits={{
            maxItemQuantity: data.settings.maxItemQuantity,
            maxItemsPerOrder: data.settings.maxItemsPerOrder,
          }}
        >
          {render({
            tableCode: data.table.code,
            tableLabel: data.table.label,
            catalog: data.catalog,
            settings: data.settings,
          })}
        </CustomerShell>
      );
  }
}
