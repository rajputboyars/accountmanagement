import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ActivateForm, ConfirmButton, GstPolicyForm, OpeningForm } from "@/components/money/setup-forms";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getAccountingStatus, previewOpening, suggestedStartDate } from "@/modules/accounting";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";
import { indiaDate } from "@/shared/financial-year";
import { formatPaise } from "@/shared/money";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("money.setup.title") };
}

const addDay = (value: string) => new Date(new Date(`${value}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

export default function MoneySetupPage() {
  return (
    <ProtectedPage permission="settings.edit" title="Business Accounts setup">
      <SetupView />
    </ProtectedPage>
  );
}

async function SetupView() {
  const [session, t] = await Promise.all([requireSession(), getT()]);
  const status = await getAccountingStatus(session);
  const today = indiaDate();
  const back = (
    <Link href="/reports/money" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" aria-hidden="true" />
      {t("money.back")}
    </Link>
  );

  if (!status.active) {
    return (
      <PageContainer className="max-w-3xl">
        {back}
        <PageIntro description={t("money.setup.description")} />
        <SectionCard title={t("money.setup.step1")}>
          <ActivateForm maxDate={addDay(today)} defaultDate={await suggestedStartDate(session)} />
        </SectionCard>
      </PageContainer>
    );
  }

  if (status.coverageStartDate! > today) {
    return (
      <PageContainer className="max-w-3xl">
        {back}
        <PageIntro description={t("money.coverage", { date: status.coverageStartDate! })} />
        <SectionCard title={t("money.setup.step2", { date: status.coverageStartDate! })}>
          <p className="text-sm text-muted-foreground">{t("money.setup.waitStart", { date: status.coverageStartDate! })}</p>
        </SectionCard>
      </PageContainer>
    );
  }
  const opening = await previewOpening(session, status.coverageStartDate!);
  const verified = status.openingStatus === "verified" && status.clearingBalancePaise === 0;
  const figures = [
    ["money.setup.owedCustomers", opening.receivablesPaise],
    ["money.setup.owedSuppliers", -opening.payablesPaise],
    ["money.setup.stock", opening.inventoryPaise],
  ] as const;
  return (
    <PageContainer className="max-w-3xl">
      {back}
      <PageIntro description={t("money.coverage", { date: status.coverageStartDate! })} />
      <SectionCard title={t("money.setup.step2", { date: opening.asOf })} description={t("money.setup.step2.help")}>
        <div className="flex flex-col gap-4">
          <dl className="grid gap-3 sm:grid-cols-3">
            {figures.map(([key, value]) => (
              <div key={key} className="flex flex-col gap-1 rounded-xl bg-muted/40 p-3">
                <dt className="text-xs text-muted-foreground">{t(key)}</dt>
                <dd className="text-lg font-semibold">
                  <Money paise={value} withPaise />
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">{t("money.setup.fromRecords")}</p>
          {opening.unvaluedProductIds.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("money.setup.unvalued", { count: opening.unvaluedProductIds.length })}{" "}
              {status.openingRecorded ? (
                <Link href="/reports/money/fix" className="font-semibold text-teal-strong hover:underline">
                  {t("money.fix.link")}
                </Link>
              ) : null}
            </p>
          ) : null}
          {status.openingRecorded ? <p className="text-sm text-success">{t("money.setup.saved")}</p> : <OpeningForm suggestedCash={opening.suggestedCashPaise} cashCountedOn={opening.lastClosedDate} />}
        </div>
      </SectionCard>
      {status.openingRecorded ? (
        <SectionCard title={t("money.setup.step3")} description={t("money.setup.step3.help")}>
          {verified ? (
            <p className="text-sm text-success">{t("money.setup.confirmed")}</p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">{t("money.setup.waiting", { amount: formatPaise(Math.abs(status.clearingBalancePaise), { withPaise: true }) })}</p>
              <ConfirmButton />
            </div>
          )}
        </SectionCard>
      ) : null}
      <SectionCard title={t("money.gst.title")}>
        <GstPolicyForm current={status.inputGstPolicy ?? "review"} />
      </SectionCard>
    </PageContainer>
  );
}
