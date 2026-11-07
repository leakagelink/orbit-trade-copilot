import { filterResearchNews } from "./research-news";

export async function loadResearchNews(symbol: string) {
  const fetchedAt = new Date().toISOString();
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=20&quotesCount=0`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("News provider unavailable");
    const articles = filterResearchNews(await response.json(),symbol);
    return { provider: "Yahoo Finance search", fetchedAt, articles, limitation: articles.length ? "Headlines and publisher metadata only; full articles are not fetched. Search coverage is incomplete." : "No recent news explicitly associated with this ticker was returned." };
  } catch {
    return { provider: "Yahoo Finance search", fetchedAt, articles: [], limitation: "News provider is unavailable. No headlines were fabricated." };
  }
}