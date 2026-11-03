import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { CashMovementForm, CloseDayForm, ExpenseForm, ReopenDayForm, VoidExpense } from "@/components/cashbook/cash-forms";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { ScrollIntoViewOnHash } from "@/components/nexora/scroll-into-view";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCashbook, listClosings } from "@/modules/cashbook";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { formatPaise } from "@/shared/money";
import { LANGUAGE_LOCALES, type Language, type MessageKey } from "@/shared/i18n";
import { differenceReasonLabel, expenseLabel, paymentMethodLabel, systemName } from "@/shared/i18n/labels";
import { HelpHint } from "@/components/nexora/help-hint";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("nav.cashbook.label") };
}

export default function CashbookPage({ searchParams }: PageProps<"/cashbook">) {
  return (
    <ProtectedPage permission="cash.record" title="Cashbook" guide="cashbook">
      <CashbookView searchParams={searchParams} />
    </ProtectedPage>
  );
}

const dateText = (value: string, language: Language) => new Intl.DateTimeFormat(LANGUAGE_LOCALES[language].dates, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const shift = (date: string, days: number) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
};
const PAYMENT_LABEL: Record<string, MessageKey> = { bill: "cashbook.payment.bill", collection: "cashbook.payment.collection", refund: "cashbook.payment.refund", supplier_paid: "cashbook.payment.supplierPaid", supplier_returned: "cashbook.payment.supplierReturned" };
const MOVEMENT_LABEL: Record<string, MessageKey> = { withdrawal: "cashbook.movement.withdrawal", bank_deposit: "cashbook.movement.bankDeposit", float_added: "cashbook.movement.floatAdded" };

async function CashbookView({ searchParams }: { searchParams: PageProps<"/cashbook">["searchParams"] }) {
  const params = await searchParams;
  const session = await requireSession();
  const book = await getCashbook(session, String(params.date ?? ""));
  const closings = await listClosings(session, 10);
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const method = (code: string) => paymentMethodLabel(t, code);
  const c = book.cash;
  const lines: { label: string; paise: number; sign: "+" | "−" }[] = [
    { label: t("cashbook.line.sales"), paise: c.cashSalesPaise, sign: "+" },
    { label: t("cashbook.line.collections"), paise: c.cashCollectionsPaise, sign: "+" },
    { label: t("cashbook.line.added"), paise: c.cashAddedPaise, sign: "+" },
    { label: t("cashbook.line.supplierReturned"), paise: c.supplierCashReturnedPaise, sign: "+" },
    { label: t("cashbook.line.refunds"), paise: c.cashRefundsPaise, sign: "−" },
    { label: t("cashbook.line.supplierPaid"), paise: c.supplierCashPaidPaise, sign: "−" },
    { label: t("cashbook.line.expenses"), paise: c.cashExpensesPaise, sign: "−" },
    { label: t("cashbook.line.withdrawn"), paise: c.cashWithdrawnPaise, sign: "−" },
  ];

  return (
    <PageContainer>
      <PageIntro description={t("cashbook.description")} />

      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/cashbook?date=${shift(book.date, -1)}`} className={buttonVariants({ variant: "outline", size: "touch" })} aria-label={t("cashbook.previousDay")}>
          <ChevronLeft aria-hidden="true" />
        </Link>
        <form action="/cashbook" className="flex items-center gap-2">
          <label>
            <span className="sr-only">{t("common.date")}</span>
            <Input type="date" name="date" defaultValue={book.date} max={book.today} className="h-11" />
          </label>
          <button type="submit" className={buttonVariants({ variant: "outline", size: "touch" })}>
            {t("common.show")}
          </button>
        </form>
        {book.date < book.today ? (
          <Link href={`/cashbook?date=${shift(book.date, 1)}`} className={buttonVariants({ variant: "outline", size: "touch" })} aria-label={t("cashbook.nextDay")}>
            <ChevronRight aria-hidden="true" />
          </Link>
        ) : null}
        {book.date !== book.today ? (
          <Link href="/cashbook" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("range.today")}
          </Link>
        ) : null}
      </div>

      <section className="grid gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:grid-cols-3 sm:p-6">
        <div className="sm:col-span-1">
          <p className="text-sm text-panel-muted">{dateText(book.date, language)}</p>
          <p className="mt-1 flex items-center gap-2 text-sm">
            {book.closed ? (
              <>
                <Lock className="size-4" aria-hidden="true" /> {t("cashbook.closedBy", { name: systemName(book.closing?.closedByName ?? "", language) })}
              </>
            ) : (
              t("cashbook.open")
            )}
          </p>
        </div>
        <div>
          <p className="text-sm text-panel-muted">{t("cashbook.expected")}</p>
          <p className="text-3xl font-bold">
            <Money paise={book.expectedPaise} withPaise />
          </p>
        </div>
        {book.closed && book.closing ? (
          <div>
            <p className="text-sm text-panel-muted">{t("cashbook.counted")}</p>
            <p className="text-3xl font-bold">
              <Money paise={book.closing.countedCashPaise} withPaise />
            </p>
            <p className="text-sm text-panel-muted">
              {book.closing.differencePaise === 0
                ? t("cashbook.drawerMatched")
                : t(book.closing.differencePaise < 0 ? "cashbook.shortBy" : "cashbook.extraBy", { amount: formatPaise(Math.abs(book.closing.differencePaise), { withPaise: true }), reason: differenceReasonLabel(t, book.closing.differenceReason ?? "") })}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-sm text-panel-muted">{t("cashbook.salesToday")}</p>
            <p className="text-3xl font-bold">
              <Money paise={book.sales.salesPaise} />
            </p>
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title={t("cashbook.drawer")} description={book.openingFromClosedDate ? t("cashbook.openingFromClosed", { date: dateText(book.openingFromClosedDate, language) }) : t("cashbook.openingFromShop")}>
          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="flex items-center gap-1 font-medium text-foreground">{t("cashbook.opening")}<HelpHint topic="openingCash" className="text-muted-foreground" /></dt>
              <dd className="font-medium">
                <Money paise={c.openingPaise} withPaise />
              </dd>
            </div>
            {lines.map((line) => (
              <div key={line.label} className={`flex justify-between gap-3 ${line.paise === 0 ? "text-muted-foreground" : "text-foreground"}`}>
                <dt>
                  {line.sign} {line.label}
                </dt>
                <dd className="tabular-nums">
                  <Money paise={line.paise} withPaise />
                </dd>
              </div>
            ))}
            <div className="mt-1 flex justify-between gap-3 border-t border-border pt-2 text-base font-bold text-foreground">
              <dt>{t("cashbook.expected")}</dt>
              <dd>
                <Money paise={book.expectedPaise} withPaise />
              </dd>
            </div>
          </dl>
        </SectionCard>

        <SectionCard title={t("cashbook.notCash")} description={t("cashbook.notCashDescription")}>
          <dl className="flex flex-col gap-1.5 text-sm">
            {book.nonCash.length === 0 ? <p className="text-muted-foreground">{t("cashbook.noNonCash")}</p> : null}
            {book.nonCash.map((row) => (
              <div key={row.method} className="flex justify-between gap-3">
                <dt className="text-foreground">{method(row.method)}</dt>
                <dd className="text-right tabular-nums">
                  {row.inPaise ? (
                    <span>{t("cashbook.in", { amount: formatPaise(row.inPaise, { withPaise: true }) })}</span>
                  ) : null}
                  {row.inPaise && row.outPaise ? " · " : ""}
                  {row.outPaise ? (
                    <span>{t("cashbook.out", { amount: formatPaise(row.outPaise, { withPaise: true }) })}</span>
                  ) : null}
                </dd>
              </div>
            ))}
            <div className="mt-2 flex justify-between gap-3 border-t border-border pt-2">
              <dt className="text-foreground">{t("cashbook.soldOnCredit")}</dt>
              <dd>
                <Money paise={book.sales.creditGivenPaise} withPaise />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{t(book.sales.billCount === 1 ? "cashbook.salesCountOne" : "cashbook.salesCount", { count: book.sales.billCount })}</dt>
              <dd>
                <Money paise={book.sales.salesPaise} withPaise />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{t("cashbook.creditNotes")}</dt>
              <dd>
                <Money paise={book.sales.creditNotesPaise} withPaise />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{t("cashbook.goodsReceived")}</dt>
              <dd>
                <Money paise={book.purchases.purchasesPaise} withPaise />
              </dd>
            </div>
          </dl>
        </SectionCard>
      </div>

      <SectionCard title={t("cashbook.recorded")} description={t("cashbook.recordedDescription")} flush>
        {book.payments.length + book.expenses.length + book.movements.length + book.sales.creditBills.length === 0 ? (
          <p className="px-5 pb-3 text-sm text-muted-foreground">{t("cashbook.nothingRecorded")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {book.payments.map((payment) => {
              const href = payment.creditNoteId ? `/billing/returns/${payment.creditNoteId}` : payment.invoiceId ? `/billing/invoices/${payment.invoiceId}` : payment.partyType === "supplier" && payment.partyId ? `/suppliers/${payment.partyId}` : null;
              const into = payment.direction === "in";
              const body = (
                <>
                  <span className="min-w-0">
                    <span className="block text-foreground">{PAYMENT_LABEL[payment.category] ? t(PAYMENT_LABEL[payment.category]!) : payment.category}</span>
                    <span className="block text-xs text-muted-foreground">
                      {method(payment.method)}
                      {payment.reference ? ` · ${payment.reference}` : ""}
                      {payment.status === "reversed" ? ` · ${t("cashbook.laterReversed")}` : ""}
                    </span>
                  </span>
                  <span className={`shrink-0 font-semibold tabular-nums ${into ? "text-success" : "text-danger"}`}>
                    {into ? "+" : "−"}
                    <Money paise={payment.amountPaise} withPaise />
                  </span>
                </>
              );
              return (
                <li key={payment.id}>
                  {href ? (
                    <Link href={href} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-muted/50">
                      {body}
                    </Link>
                  ) : (
                    <div className="flex items-center justify-between gap-3 px-5 py-2.5">{body}</div>
                  )}
                </li>
              );
            })}
            {book.sales.creditBills.map((bill) => (
              <li key={bill.id}>
                <Link href={`/billing/invoices/${bill.id}`} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-muted/50">
                  <span>
                    <span className="block text-foreground">{t("cashbook.billOnCredit", { number: bill.number })}</span>
                    <span className="block text-xs text-muted-foreground">{t("cashbook.notMoney")}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    <Money paise={bill.totalPaise - bill.paidNowPaise} withPaise />
                  </span>
                </Link>
              </li>
            ))}
            {book.expenses.map((expense) => (
              <li key={expense.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                <span className="min-w-0">
                  <span className="block text-foreground">
                    {expenseLabel(t, { key: expense.category, label: expense.category })}
                    {expense.note ? `: ${expense.note}` : ""}
                    {expense.status === "voided" ? <Badge variant="neutral" className="ml-2">{t("cashbook.voided")}</Badge> : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t("cashbook.expense")} · {method(expense.method)}
                    {expense.reference ? ` · ${expense.reference}` : ""} · {systemName(expense.createdByName, language)}
                    {expense.status === "voided" ? ` · ${t("cashbook.voidedBecause", { reason: expense.voidReason ?? "" })}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className={`font-semibold tabular-nums ${expense.status === "voided" ? "text-muted-foreground line-through" : "text-danger"}`}>
                    −<Money paise={expense.amountPaise} withPaise />
                  </span>
                  {expense.canVoid && book.canRecord ? <VoidExpense expenseId={expense.id} /> : null}
                </span>
              </li>
            ))}
            {book.movements.map((movement) => (
              <li key={movement.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <span>
                  <span className="block text-foreground">{t(MOVEMENT_LABEL[movement.kind]!)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t("common.cash")} · {systemName(movement.createdByName, language)}
                    {movement.note ? ` · ${movement.note}` : ""}
                  </span>
                </span>
                <span className={`shrink-0 font-semibold tabular-nums ${movement.kind === "float_added" ? "text-success" : "text-danger"}`}>
                  {movement.kind === "float_added" ? "+" : "−"}
                  <Money paise={movement.amountPaise} withPaise />
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-3">
        {book.canRecord ? (
          <>
            <SectionCard help="expenses" title={t("cashbook.addExpense")} description={t("cashbook.addExpenseDescription")} anchorId="section-add-an-expense">
              <ExpenseForm date={book.date} />
              <ScrollIntoViewOnHash anchorId="section-add-an-expense" />
            </SectionCard>
            <SectionCard help="cashInOut" title={t("cashbook.cashInOut")} description={t("cashbook.cashInOutDescription")}>
              <CashMovementForm date={book.date} />
            </SectionCard>
          </>
        ) : null}
        {book.canClose ? (
          <SectionCard title={t("cashbook.closeDay")} description={t("cashbook.closeDayDescription")}>
            <CloseDayForm date={book.date} expectedPaise={book.expectedPaise} />
          </SectionCard>
        ) : book.canReopen ? (
          <SectionCard title={t("cashbook.dayClosed")} description={t("cashbook.dayClosedDescription")}>
            <ReopenDayForm date={book.date} />
          </SectionCard>
        ) : book.closed ? (
          <SectionCard title={t("cashbook.dayClosed")} description={t("cashbook.ownerReopens")}>
            <p className="text-sm text-muted-foreground">{t("cashbook.useToday")}</p>
          </SectionCard>
        ) : null}
      </div>

      {closings.length > 0 ? (
        <SectionCard title={t("cashbook.recentClosings")} flush>
          <ul className="flex flex-col divide-y divide-border text-sm">
            {closings.map((closing) => (
              <li key={closing.businessDate}>
                <Link href={`/cashbook?date=${closing.businessDate}`} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-muted/50">
                  <span>
                    {dateText(closing.businessDate, language)}
                    {closing.status === "reopened" ? <Badge variant="warning" className="ml-2">{t("cashbook.reopened")}</Badge> : null}
                  </span>
                  <span className="text-right tabular-nums">
                    <Money paise={closing.countedCashPaise} withPaise />
                    {closing.differencePaise !== 0 ? (
                      <span className={`ml-2 text-xs ${closing.differencePaise < 0 ? "text-danger" : "text-success"}`}>
                        {closing.differencePaise < 0 ? "−" : "+"}
                        <Money paise={Math.abs(closing.differencePaise)} withPaise />
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </PageContainer>
  );
}
