/** Public brand and canonical web address, shared by page metadata and legal pages. */
export const SITE_NAME = "AlgoVirt";
export const SITE_URL = "https://algovirt.com";
export const SITE_DOMAIN = "algovirt.com";

export function canonical(path: string) {
  const url = `${SITE_URL}${path === "/" ? "" : path}`;
  return { meta: { property: "og:url", content: url }, link: { rel: "canonical", href: url } };
}
