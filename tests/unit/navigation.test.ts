import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS, NAV_PERMISSION, navKeysFor } from "@/config/navigation";
import { DEFAULT_PERMISSIONS, ROLE_NAMES, type RoleName } from "@/shared/permissions";

const granted = (role: RoleName) => new Set(Object.entries(DEFAULT_PERMISSIONS).filter(([, roles]) => (roles as readonly string[]).includes(role)).map(([permission]) => permission));

describe("navigation by role", () => {
  it("offers each role only the sections its default permissions open", () => {
    expect(navKeysFor(granted("owner"))).toEqual(NAV_ITEMS.map((item) => item.key));
    expect(navKeysFor(granted("manager"))).toEqual(["dashboard", "billing", "inventory", "customers", "purchases", "suppliers", "cashbook", "reports", "approvals", "settings"]);
    expect(navKeysFor(granted("cashier"))).toEqual(["billing", "customers", "approvals", "settings"]);
    expect(navKeysFor(granted("inventory"))).toEqual(["inventory", "purchases", "suppliers", "approvals", "settings"]);
  });

  it("always includes each role's home page and the sections everyone may open", () => {
    const home: Record<RoleName, string> = { owner: "dashboard", manager: "dashboard", cashier: "billing", inventory: "inventory" };
    for (const role of ROLE_NAMES) {
      expect(navKeysFor(granted(role)), role).toContain(home[role]);
      expect(navKeysFor(granted(role)), role).toEqual(expect.arrayContaining(["approvals", "settings"]));
    }
    expect(navKeysFor(new Set())).toEqual(["settings"]); // a role with nothing granted still reaches its own PIN and sign-out
  });

  it("uses the same permission as each section's page guard, so the menu and the server never disagree", () => {
    for (const item of NAV_ITEMS) {
      const page = readFileSync(`src/app/(app)${item.href}/page.tsx`, "utf8");
      const guard = page.match(/<ProtectedPage permission="([^"]+)"/)?.[1] ?? null;
      expect(NAV_PERMISSION[item.key], item.key).toBe(guard === null && item.key === "approvals" ? "approvals.view" : guard);
    }
  });
});
