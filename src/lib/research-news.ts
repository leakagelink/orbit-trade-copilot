import { z } from "zod";

export const newsItem = z.object({
  uuid: z.string().min(1).max(100), title: z.string().min(1).max(500),
  publisher: z.string().min(1).max(120), link: z.string().url(),
  providerPublishTime: z.number().finite(), relatedTickers: z.array(z.string()).default([]),
});
export type ResearchNewsItem = z.infer<typeof newsItem>;
export function filterResearchNews(payload: unknown, symbol: string, now = Date.now()): ResearchNewsItem[] {
  const parsed = z.object({ news: z.array(z.unknown()) }).safeParse(payload);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  return parsed.data.news.flatMap(item => {
    const result = newsItem.safeParse(item);
    if (!result.success) return [];
    const value = result.data;
    const url = new URL(value.link);
    const age = now - value.providerPublishTime * 1000;
    if (url.protocol !== "https:" || url.username || url.password || age < 0 || age > 7 * 86400000 || !value.relatedTickers.includes(symbol) || seen.has(value.uuid)) return [];
    seen.add(value.uuid);
    return [value];
  }).slice(0,8);
}