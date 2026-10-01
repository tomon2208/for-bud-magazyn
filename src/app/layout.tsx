import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FOR-BUD Magazyn",
  description: "System magazynowy FOR-BUD",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pl" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
