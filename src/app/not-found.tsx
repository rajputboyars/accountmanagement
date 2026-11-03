import { Suspense } from "react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { getT } from "@/server/i18n";

/** Unknown address. Records of another shop also end up here or on a "not found" card, never revealed. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm font-semibold text-teal-strong">404</p>
      <Suspense fallback={null}>
        <NotFoundText />
      </Suspense>
    </main>
  );
}

async function NotFoundText() {
  const t = await getT();
  return (
    <>
      <h1 className="text-xl font-bold text-foreground">{t("notFound.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("notFound.body")}</p>
      <Link href="/dashboard" className={buttonVariants({ size: "touch" })}>
        {t("common.goToDashboard")}
      </Link>
    </>
  );
}
