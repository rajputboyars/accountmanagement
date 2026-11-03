import Link from "next/link";
import { getT } from "@/server/i18n";
import { Lock } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/** Shown when the signed-in role lacks a page's permission. The server also refuses the data and actions. */
export async function AccessDenied({ homeHref }: { title: string; homeHref: string }) {
  const t = await getT();
  return (
    <section
      role="alert"
      className="flex flex-col items-center gap-4 rounded-3xl border border-border bg-card px-6 py-14 text-center shadow-[0_1px_2px_rgba(20,36,58,0.04)]"
    >
      <span className="grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Lock className="size-7" aria-hidden="true" />
      </span>
      <h2 className="text-xl font-semibold text-foreground">{t("access.title")}</h2>
      <p className="max-w-md text-muted-foreground">{t("access.body")}</p>
      <Link href={homeHref} className={buttonVariants({ size: "touch" })}>
        {t("access.goToWork")}
      </Link>
    </section>
  );
}
