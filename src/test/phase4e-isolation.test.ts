// Phase 4E change control (verification and design only): none of the 174 protected files fingerprinted at the start of
// Phase 4E changed; drafts 0046 and 0047 are byte-identical; the new draft 0048 exists only as a proposal (not in the
// applied Drizzle journal); no application source under src/lib or src/routes changed for this phase.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const START = readFileSync("docs/phase-4e/protected-files-at-start.sha256", "utf8").trim().split("\n").map((l) => { const [h, ...p] = l.split(/\s+/); return { hash: h!, path: p.join(" ") }; });

describe("Phase 4E change control", () => {
  it("all 174 protected files are unchanged since the start of Phase 4E", () => {
    expect(START).toHaveLength(174);
    const changed = START.filter((f) => sha(f.path) !== f.hash).map((f) => f.path);
    expect(changed).toEqual([]);
  });
  it("drafts 0046 and 0047 are byte-identical to their Phase 4D hashes", () => {
    expect(sha("docs/proposed-migrations/0046_futures_paper_ledger_v2.sql")).toBe("eac47d85843e9c1eaba249d7768ebec76e8c1c86c071bedf7fb5ca1a51b4623e");
    expect(sha("docs/proposed-migrations/0046_futures_paper_ledger_v2.rollback.sql")).toBe("dd8b96bafee966a28bd0bd51bec74678c463fe0ca6f6c75518733d88fc999453");
    expect(sha("docs/proposed-migrations/0047_futures_strategy_attribution.sql")).toBe("42d3c65e95c06775252d3cd0454581a3f70b803f690d22aab457f1d7e249801b");
    expect(sha("docs/proposed-migrations/0047_futures_strategy_attribution.rollback.sql")).toBe("bb980bbcc5849ddd1fb671064f0fb568d6e6de1345127dfc635aa7a0f3755ae8");
  });
  it("no draft (0040–0048) is in the applied Drizzle journal; the journal still ends at 0039", () => {
    const j = JSON.parse(readFileSync("drizzle/migrations/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
    expect(j.entries.at(-1)!.tag).toBe("0039_futures_pass_certification_and_autopilot_fencing");
    expect(j.entries.some((e) => /^00(4\d)_/.test(e.tag))).toBe(false);
  });
  it("the Phase 4D engine and the shadow modules keep their Phase 4D hashes (no engine change in Phase 4E)", () => {
    expect(sha("src/lib/futures-paper-engine.ts")).toBe("588d782d0e58bf2c6cafb7c29fb0f12c2f06f5366a352695a7f93718a263c3a9");
    expect(sha("src/lib/central-risk-shadow.ts")).toBe("76f27f3e2e8c3eff0cb11e27297cd26f7202f07062bb1e9878d17cdf103aa4cf");
    expect(sha("src/lib/central-risk-shadow.server.ts")).toBe("dda46802ad54f209c139ed48c1bdd0acfc5acefb6a16c57e4eb69ed6ca377037");
  });
});
