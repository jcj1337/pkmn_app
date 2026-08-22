import CardSearch from "./components/CardSearch";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 pt-16 pb-20">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            Know what a card is{" "}
            <span className="text-emerald-700 dark:text-emerald-400">
              worth paying
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-slate-600 dark:text-slate-400">
            TCGracker reads TCGplayer market pricing and recent eBay sold
            listings, groups them into genuinely comparable sales, and
            recommends a price to buy at — or tells you when the evidence is
            too thin to say.
          </p>
        </div>

        <CardSearch />
      </main>

      <SiteFooter />
    </div>
  );
}
