import { NextResponse } from "next/server";
import { TcgdexError, searchCards } from "@/lib/card-search";

/**
 * Proxies card search through the server so the browser only talks to our own
 * origin and the upstream shape stays out of the client bundle.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";

  if (!query) {
    return NextResponse.json(
      { error: "Enter a card name to search." },
      { status: 400 },
    );
  }

  try {
    const cards = await searchCards(query);
    return NextResponse.json({ cards });
  } catch (error) {
    const message =
      error instanceof TcgdexError
        ? error.message
        : "Something went wrong while searching.";

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
