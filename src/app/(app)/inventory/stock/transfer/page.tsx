import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { TransferForm } from "@/components/inventory/transfer-form";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { listTransfers, transferOptions } from "@/modules/inventory";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { billDate } from "@/shared/i18n/labels";


export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("godown.transfer.title") };
}

export default function TransferPage() {
  return (
    <ProtectedPage permission="stock.adjust" title="Move stock">
      <TransferView />
    </ProtectedPage>
  );
}

async function TransferView() {
  const [session, t, language] = await Promise.all([requireSession(), getT(), getLanguage()]);
  const [options, recent] = await Promise.all([transferOptions(session), listTransfers(session, 10)]);
  return (
    <PageContainer className="max-w-3xl">
      <Link href="/inventory/stock" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("page.stock")}
      </Link>
      <PageIntro description={t("godown.transfer.intro")} />
      {options.godowns.length < 2 ? (
        <SectionCard title={t("godown.transfer.title")}>
          <p className="text-sm text-muted-foreground">{t("godown.transfer.needTwo")}</p>
        </SectionCard>
      ) : (
        <SectionCard title={t("godown.transfer.title")}>
          <TransferForm options={options} />
        </SectionCard>
      )}
      <SectionCard title={t("godown.transfer.history")}>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("godown.transfer.none")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {recent.map((transfer) => (
              <li key={transfer.id} className="flex flex-col gap-0.5 py-2">
                <span className="font-medium text-foreground">{t("godown.transfer.row", { number: transfer.number, from: transfer.from === "Main Store" ? t("godown.mainStore") : transfer.from, to: transfer.to === "Main Store" ? t("godown.mainStore") : transfer.to, count: transfer.lines })}</span>
                <span className="text-xs text-muted-foreground">{billDate(transfer.date, language)}{transfer.reason ? ` · ${transfer.reason}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </PageContainer>
  );
}
