import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FinishBox, ReconcileInputs } from "@/components/bank/reconcile-form";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { getBankAccount } from "@/modules/accounting";
import { listReconciliations, previewReconciliation, type ReconciliationFigures } from "@/modules/banking";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getLanguage, getT } from "@/server/i18n";
import { indiaDate } from "@/shared/financial-year";
import { billDate } from "@/shared/i18n/labels";
import { formatPaise } from "@/shared/money";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("bank.rec.title") };
}

type Props = { params: Promise<{ accountId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default function ReconcilePage(props: Props) {
  return (
    <ProtectedPage permission="settings.edit" title="Reconcile">
      <ReconcileView {...props} />
    </ProtectedPage>
  );
}

const rs = (paise: number) => formatPaise(paise, { withPaise: true });
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

function Row({ label, paise, hint, strong }: { label: string; paise: number; hint?: string; strong?: boolean }) {
  return (
    <li className="flex items-baseline justify-between gap-4 py-2">
      <span className="min-w-0 text-sm">
        <span className={strong ? "font-semibold text-foreground" : "text-foreground"}>{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <span className={strong ? "text-base font-semibold tabular-nums" : "text-sm tabular-nums"}>
        <Money paise={paise} withPaise />
      </span>
    </li>
  );
}

async function ReconcileView({ params, searchParams }: Props) {
  const [{ accountId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const account = await getBankAccount(session, accountId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!account) return null;
  const today = indiaDate();
  const date = one(query.date);
  const balance = one(query.balance);
  let figures: (ReconciliationFigures & { lastFinalized: string | null }) | null = null;
  let problem: string | null = null;
  if (date && balance) {
    try {
      figures = await previewReconciliation(session, { bankAccountId: account.id, statementDate: date, statementBalance: balance });
    } catch (error) {
      problem = (await toActionError(error)).error;
    }
  }
  const history = await listReconciliations(session, account.id);
  const minDate = history[0]?.statementDate ?? account.openingAsOf;
  return (
    <PageContainer className="max-w-3xl">
      <Link href={`/reports/money/bank/${account.id}`} className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {account.name}
      </Link>
      <PageIntro description={t("bank.rec.intro")} />
      <SectionCard title={t("bank.rec.title")}>
        <ReconcileInputs today={today} min={minDate} date={date || today} balance={balance} />
        {problem ? <p role="alert" className="mt-3 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">{problem}</p> : null}
      </SectionCard>

      {figures ? (
        <SectionCard title={t("bank.rec.result", { date: billDate(figures.statementDate, language) })}>
          <div className="flex flex-col gap-4">
            <p className={figures.differencePaise === 0 && figures.unresolvedLines === 0 ? "rounded-xl bg-success-soft px-4 py-3 text-sm text-success" : "rounded-xl bg-amber-soft px-4 py-3 text-sm text-amber-ink"}>
              {figures.unresolvedLines > 0
                ? t("bank.rec.unresolved", { count: figures.unresolvedLines })
                : figures.explanation === "balanced"
                  ? t("bank.rec.balancedSentence")
                  : figures.explanation === "bank_has_more"
                    ? t("bank.rec.bankMore", { amount: rs(Math.abs(figures.differencePaise)) })
                    : t("bank.rec.booksMore", { amount: rs(Math.abs(figures.differencePaise)) })}
            </p>
            <ul className="flex flex-col divide-y divide-border">
              <Row label={t("bank.rec.statementBalance")} paise={figures.statementBalancePaise} />
              <Row label={t("bank.rec.bookBalance")} paise={figures.bookBalancePaise} />
              {figures.bookNotInBankPaise !== 0 ? <Row label={t("bank.rec.notInBank")} paise={figures.bookNotInBankPaise} hint={t("bank.rec.notInBankHint")} /> : null}
              {figures.bankNotInBooksPaise !== 0 ? <Row label={t("bank.rec.notInBooks")} paise={figures.bankNotInBooksPaise} hint={figures.ignoredPaise !== 0 ? t("bank.rec.ignoredHint") : t("bank.rec.notInBooksHint")} /> : null}
              {figures.openingGapPaise !== 0 ? <Row label={t("bank.rec.openingGap")} paise={figures.openingGapPaise} hint={t("bank.rec.openingGapHint")} /> : null}
              <Row label={t("bank.rec.difference")} paise={figures.differencePaise} strong />
            </ul>
            {figures.linesMismatch ? <p className="text-xs text-muted-foreground">{t("bank.rec.linesMismatch", { amount: rs(figures.linesBalancePaise) })}</p> : null}
            {figures.waitingForBankPaise !== 0 ? <p className="text-xs text-muted-foreground">{t("bank.rec.waiting", { amount: rs(figures.waitingForBankPaise) })}</p> : null}
            {figures.outstanding.length > 0 ? (
              <details className="text-sm">
                <summary className="cursor-pointer font-medium text-teal-strong">{t("bank.rec.outstanding", { count: figures.outstanding.length })}</summary>
                <ul className="mt-2 flex flex-col divide-y divide-border">
                  {figures.outstanding.map((item, index) => (
                    <li key={index} className="flex items-baseline justify-between gap-3 py-1.5 text-xs">
                      <span>
                        {billDate(item.date, language)} · {item.partyName ?? item.label}
                        {item.reference ? ` · ${item.reference}` : ""}
                      </span>
                      <Money paise={item.signedPaise} withPaise />
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <FinishBox bankAccountId={account.id} date={figures.statementDate} balance={balance} canFinish={figures.canFinish} />
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title={t("bank.rec.history")} description={t("bank.rec.historyHelp")}>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("bank.rec.noHistory")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {history.map((row) => (
              <li key={row.id} className="flex flex-col gap-1 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">{billDate(row.statementDate, language)}</span>
                  <Badge variant="success">{t("bank.rec.done")}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("bank.rec.historyLine", { statement: rs(row.statementBalancePaise), matched: row.matchedCount })}
                </p>
                {row.note ? <p className="text-xs text-muted-foreground">{row.note}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </PageContainer>
  );
}
