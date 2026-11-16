import type { Metadata, Viewport } from "next";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/instrument-sans";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Sandwich Express",
    template: "%s · Sandwich Express",
  },
  description:
    "Scan the QR code on your table, build your sandwich, pay on your phone. Dine-in table ordering for Sandwich Express.",
  applicationName: "Sandwich Express",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1f4d3a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
