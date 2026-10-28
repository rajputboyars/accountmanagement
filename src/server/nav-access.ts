import { cache } from "react";
import { navKeysFor } from "@/config/navigation";
import { loadPermissions } from "@/modules/identity";
import { homePathForRole, requireSession } from "./auth";

/** What the menus may offer this request's signed-in person: their sections and home page. Once per request. */
export const getNavAccess = cache(async () => {
  const session = await requireSession();
  const granted = await loadPermissions(session);
  return { allowed: navKeysFor(granted), homeHref: homePathForRole(session.role) };
});
