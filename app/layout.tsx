import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "TCGracker",
    // Card pages set their own title; this keeps the brand on the end of it.
    template: "%s · TCGracker",
  },
  description:
    "Track what Pokémon cards actually sell for. TCGplayer market pricing, " +
    "recent eBay sold listings, and an explainable recommended buy price.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${inter.className} min-h-screen bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100`}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        >
          {/* Was Poké Ball red; now keyed to the emerald the pricing panels
              use, so the ambient wash belongs to TCGracker rather than to a
              franchise. */}
          <div className="absolute -top-48 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-3xl" />
          <div className="absolute top-1/3 -right-40 h-[28rem] w-[28rem] rounded-full bg-sky-400/10 blur-3xl" />
          <div className="absolute -bottom-40 -left-40 h-[28rem] w-[28rem] rounded-full bg-amber-400/10 blur-3xl" />
        </div>

        {children}
      </body>
    </html>
  );
}
