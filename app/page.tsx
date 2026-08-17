import CardSearch from "./components/CardSearch";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 pt-16 pb-20">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            Pokémon Price Checker
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-pretty text-slate-600 dark:text-slate-400">
            Look up any card to see its current market price and what it has
            actually been selling for.
          </p>
        </div>

        <CardSearch />
      </main>

      <SiteFooter />
    </div>
  );
}
