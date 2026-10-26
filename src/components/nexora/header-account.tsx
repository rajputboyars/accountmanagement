import Link from "next/link";
import { Bell, LogOut } from "lucide-react";
import { signOutAction } from "@/app/(auth)/login/actions";
import { countUnreadNotifications } from "@/modules/identity";
import { getCurrentShop } from "@/modules/settings";
import { getCurrentSession } from "@/server/auth";

const ROLE_LABELS = { owner: "Owner", manager: "Manager", cashier: "Cashier", inventory: "Inventory" } as const;

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

/** Shop name for the header, read from the signed-in session. */
export async function HeaderShopName() {
  const session = await getCurrentSession();
  if (!session) return null;
  const shop = await getCurrentShop(session);
  return <>{shop.name}</>;
}

/** Signed-in person and the sign-out button. */
export async function HeaderAccount() {
  const session = await getCurrentSession();
  if (!session) return null;
  const unread = await countUnreadNotifications(session);
  return (
    <div className="flex items-center gap-2">
      <Link href="/notifications" className="relative grid size-11 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
        <Bell className="size-5" aria-hidden="true" />
        {unread ? (
          <span aria-hidden="true" className="absolute top-1.5 right-1.5 grid min-w-5 place-items-center rounded-full bg-danger px-1 text-[11px] font-semibold text-white tabular-nums">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </Link>
      <div className="flex items-center gap-2.5 rounded-full border border-border bg-card py-1 pr-1 pl-1 sm:pr-3">
        <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-teal-soft text-sm font-semibold text-teal-strong">
          {initials(session.name)}
        </span>
        <span className="hidden flex-col leading-tight sm:flex">
          <span className="text-sm font-semibold text-foreground">{session.name}</span>
          <span className="text-xs text-muted-foreground">{ROLE_LABELS[session.role]}</span>
        </span>
        <span className="sr-only sm:hidden">
          Signed in as {session.name}, {ROLE_LABELS[session.role]}
        </span>
      </div>
      <form action={signOutAction}>
        <button
          type="submit"
          aria-label="Sign out"
          title="Sign out"
          className="grid size-11 place-items-center rounded-full border border-border bg-card text-foreground transition-colors hover:bg-muted md:size-10"
        >
          <LogOut className="size-[18px]" aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
