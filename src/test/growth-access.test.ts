import { describe, expect, it } from "vitest";
import { canOpen } from "@/lib/plans";

describe("growth page access", () => {
  it("Free users can open learn, invites, leaderboard and admin (admin checks role itself)", () => {
    for (const p of ["/learn", "/referrals", "/leaderboard", "/admin"]) expect(canOpen(p, "free")).toBe(true);
  });
  it("strategy marketplace needs Pro", () => {
    expect(canOpen("/marketplace", "free")).toBe(false);
    expect(canOpen("/marketplace", "pro")).toBe(true);
  });
});
