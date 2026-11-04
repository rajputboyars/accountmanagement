import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FixRow } from "@/components/money/fix-form";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { listOpeningGaps } from "@/modules/accounting";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("money.fix.title") };
}

export default function MoneyFixPage() {
  return (
    <ProtectedPage permission="settings.edit" title="Add missing costs">
      <FixView />
    </ProtectedPage>
  );
}

async function FixView() {
  const [session, t] = await Promise.all([requireSession(), getT()]);
  const gaps = await listOpeningGaps(session);
  return (
    <PageContainer className="max-w-3xl">
      <Link href="/reports/money" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("money.back")}
      </Link>
      <PageIntro description={t("money.fix.description")} />
      {gaps.length === 0 ? <p className="text-sm text-success">{t("money.fix.none")}</p> : null}
      {gaps.map((gap) => (
        <SectionCard key={gap.gapId} title={`${gap.name} (${gap.sku})`} description={t("money.fix.cutover", { date: gap.cutoverDate })}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{t("money.fix.remaining", { remaining: gap.remainingQuantity, total: gap.quantity, unit: gap.baseUnit })}</p>
            {gap.valuedPaise > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("money.fix.valued", { amount: "" })}
                <Money paise={gap.valuedPaise} withPaise />
              </p>
            ) : null}
            <FixRow gapId={gap.gapId} name={gap.name} sku={gap.sku} baseUnit={gap.baseUnit} remaining={gap.remainingQuantity} />
            <p className="text-xs text-muted-foreground">{t("money.fix.reconfirm")}</p>
          </div>
        </SectionCard>
      ))}
    </PageContainer>
  );
}
