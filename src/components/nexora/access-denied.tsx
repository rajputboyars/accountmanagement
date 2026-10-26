import Link from "next/link";
import { Lock } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/** Shown when the signed-in role lacks a page's permission. The server also refuses the data and actions. */
export function AccessDenied({ title, homeHref }: { title: string; homeHref: string }) {
  return (
    <section
      role="alert"
      className="flex flex-col items-center gap-4 rounded-3xl border border-border bg-card px-6 py-14 text-center shadow-[0_1px_2px_rgba(20,36,58,0.04)]"
    >
      <span className="grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Lock className="size-7" aria-hidden="true" />
      </span>
      <h2 className="text-xl font-semibold text-foreground">You don&apos;t have access to {title}</h2>
      <p className="max-w-md text-muted-foreground">Your role can&apos;t open this page. Ask the shop owner if you need access.</p>
      <Link href={homeHref} className={buttonVariants({ size: "touch" })}>
        Go to my work
      </Link>
    </section>
  );
}
