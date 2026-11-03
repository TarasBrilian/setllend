import type { Metadata } from "next";
import { Figtree } from "next/font/google";
import { Header } from "@/components/header";
import { Providers } from "./providers";
import "./globals.css";

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Setllend",
  description: "Fixed-rate lending and borrowing across Base and Arbitrum, settled on NEAR Intents",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${figtree.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-7xl flex-1 px-8 pb-16">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
