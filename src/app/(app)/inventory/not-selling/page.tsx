import type { Metadata } from "next";
import { cn } from "cn";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { DEFAULT_NOT_SELLING_DAYS, NOT_SELLING_CHOICES, stockNotSelling } from "@/modules/inventory";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { billDate } from "@/shared/i18n/labels";
import { unitShort } from "@/shared/i18n/unit-labels";
import { AGE_BUCKETS } from "@/shared/stock-age";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("stockAge.title") };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default function NotSellingPage({ searchParams }: Props) {
  return (
    <ProtectedPage permission="inventory.view" title="Stock not selling">
      <NotSellingView searchParams={searchParams} />
    </ProtectedPage>
  );
}

async function NotSellingView({ searchParams }: Props) {
  const query = await searchParams;
  const raw = Number(Array.isArray(query.days) ? query.days[0] : query.days);
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const result = await stockNotSelling(session, { days: Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NOT_SELLING_DAYS });
  return (
    <PageContainer className="max-w-5xl">
      <Link href="/dashboard" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("stockAge.back")}
      </Link>
      <PageIntro description={t("stockAge.intro")} />
      <section className="flex flex-col gap-3 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
        <h2 className="text-xl font-bold">{result.itemCount === 0 ? t("stockAge.none", { days: result.days }) : t("stockAge.summary", { count: result.itemCount, days: result.days })}</h2>
        {result.valuePaise !== null && result.itemCount > 0 ? (
          <p className="text-sm text-panel-muted">
            {result.valuePartial ? t("stockAge.valueAtLeast") : t("stockAge.value")}{" "}
            <span className="text-lg font-semibold text-panel-foreground">
              <Money paise={result.valuePaise} withPaise />
            </span>
          </p>
        ) : null}
        <nav aria-label={t("stockAge.period")} className="flex flex-wrap gap-2">
          {NOT_SELLING_CHOICES.map((choice) => (
            <Link key={choice} href={`/inventory/not-selling?days=${choice}`} aria-current={choice === result.days ? "true" : undefined} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium", choice === result.days ? "border-transparent bg-panel-foreground text-panel" : "border-panel-muted/40 text-panel-foreground hover:bg-white/10")}>
              {t("stockAge.days", { days: choice })}
            </Link>
          ))}
        </nav>
      </section>

      {result.items.length > 0 ? (
        <SectionCard title={t("stockAge.listTitle")} description={t("stockAge.listHelp")} flush>
          <ul className="flex flex-col divide-y divide-border">
            {result.items.map((item) => (
              <li key={item.productId} className="flex flex-col gap-2 px-5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    <Link href={`/inventory/stock/${item.productId}`} className="font-medium text-foreground hover:underline">
                      {item.name}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {item.lastSaleDate ? `${t("stockAge.lastSold", { date: billDate(item.lastSaleDate, language), days: item.daysSinceLastSale ?? 0 })} · ` : null}
                      {item.onHand} {unitShort(t, item.baseUnit)}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {item.status === "never_sold" ? <Badge variant="neutral">{t("stockAge.neverSold")}</Badge> : null}
                    {!item.ageReliable || item.unknownAgeQty !== "0" ? <Badge variant="outline">{t("stockAge.unknownAge")}</Badge> : null}
                    {item.nonMoving ? <Badge variant="danger">{t("stockAge.notMoving")}</Badge> : <Badge variant="warning">{t("stockAge.slow")}</Badge>}
                    {item.valuePaise !== null ? (
                      <span className="text-sm font-semibold tabular-nums">
                        {item.valuePartial ? "≥ " : ""}
                        <Money paise={item.valuePaise} withPaise />
                      </span>
                    ) : null}
                  </span>
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium text-teal-strong">{t("stockAge.where")}</summary>
                  <div className="mt-2 flex flex-col gap-2">
                    {!item.ageReliable ? (
                      <p className="rounded-lg bg-amber-soft px-3 py-2 text-amber-ink">{t("stockAge.unreliable")}</p>
                    ) : (
                      <p className="text-muted-foreground">{t("stockAge.estimateNote")}</p>
                    )}
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[34rem] text-xs">
                        <thead>
                          <tr className="text-left text-muted-foreground">
                            <th className="py-1 pr-3 font-medium">{t("stockAge.godown")}</th>
                            <th className="py-1 pr-3 text-right font-medium">{t("stockAge.onHand")}</th>
                            {item.ageReliable ? AGE_BUCKETS.map((bucket) => (
                              <th key={bucket} className="py-1 pr-3 text-right font-medium">
                                {t(`stockAge.bucket.${bucket}`)}
                              </th>
                            )) : null}
                            {item.valuePaise !== null ? <th className="py-1 text-right font-medium">{t("stockAge.worth")}</th> : null}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {item.godowns.map((godown) => (
                            <tr key={godown.godownId}>
                              <td className="py-1.5 pr-3">{godown.godownName === "Main Store" ? t("godown.mainStore") : godown.godownName}</td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{godown.onHand}</td>
                              {item.ageReliable ? AGE_BUCKETS.map((bucket) => (
                                <td key={bucket} className="py-1.5 pr-3 text-right tabular-nums">
                                  {godown.buckets[bucket] === "0" ? "–" : godown.buckets[bucket]}
                                </td>
                              )) : null}
                              {godown.valuePaise !== null ? (
                                <td className="py-1.5 text-right tabular-nums">
                                  <Money paise={godown.valuePaise} withPaise />
                                </td>
                              ) : null}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {item.ageReliable && item.unknownAgeQty !== "0" ? <p className="text-muted-foreground">{t("stockAge.unknownNote", { qty: item.unknownAgeQty })}</p> : null}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </PageContainer>
  );
}
