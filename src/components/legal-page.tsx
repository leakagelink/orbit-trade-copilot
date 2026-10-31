import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Logo } from "@/components/app-shell";
import { canonical, SITE_DOMAIN, SITE_NAME } from "@/lib/site";

export const LEGAL_LINKS = [
  { to: "/terms", label: "Terms of Service" },
  { to: "/privacy", label: "Privacy Policy" },
  { to: "/risk-disclosure", label: "Risk Disclosure" },
  { to: "/refunds", label: "Refund Policy" },
] as const;

/** Company details are placeholders until the owner provides the registered name, country and contact. */
export const COMPANY = { name: SITE_NAME, website: SITE_DOMAIN, contact: "the in-app Support mailbox", updated: "October 31, 2026" };

export function legalHead(title: string, description: string, path: string) {
  const c = canonical(path);
  return {
    meta: [
      { title: `${title} — ${SITE_NAME}` },
      { name: "description", content: description },
      { property: "og:title", content: `${title} — ${SITE_NAME}` },
      { property: "og:description", content: description },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary" },
      c.meta,
    ],
    links: [c.link],
  };
}

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4"><Link to="/"><Logo /></Link><Link to="/auth" className="text-sm text-primary">Sign in</Link></div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="text-3xl font-bold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated {COMPANY.updated}</p>
        <div className="legal-body mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc">{children}</div>
        <nav className="mt-12 flex flex-wrap gap-4 border-t pt-6 text-sm">{LEGAL_LINKS.map(l => <Link key={l.to} to={l.to} className="text-primary">{l.label}</Link>)}</nav>
      </main>
    </div>
  );
}
