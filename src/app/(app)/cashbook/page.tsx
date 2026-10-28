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
import { EXPENSE_CATEGORIES } from "@/shared/cashbook";

export const metadata: Metadata = { title: "Cashbook" };

export default function CashbookPage({ searchParams }: PageProps<"/cashbook">) {
  return (
    <ProtectedPage permission="cash.record" title="Cashbook">
      <CashbookView searchParams={searchParams} />
    </ProtectedPage>
  );
}

const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const shift = (date: string, days: number) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
};
const METHOD: Record<string, string> = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank", cheque: "Cheque" };
const CATEGORY = Object.fromEntries(EXPENSE_CATEGORIES.map((category) => [category.key, category.label]));
const PAYMENT_LABEL: Record<string, string> = { bill: "Paid on a bill", collection: "Old dues paid", refund: "Refund to customer", supplier_paid: "Paid to supplier", supplier_returned: "Supplier payment reversed" };
const MOVEMENT_LABEL: Record<string, string> = { withdrawal: "Owner took cash", bank_deposit: "Deposited in bank", float_added: "Cash put in" };

async function CashbookView({ searchParams }: { searchParams: PageProps<"/cashbook">["searchParams"] }) {
  const params = await searchParams;
  const session = await requireSession();
  const book = await getCashbook(session, String(params.date ?? ""));
  const closings = await listClosings(session, 10);
  const c = book.cash;
  const lines: { label: string; paise: number; sign: "+" | "−" }[] = [
    { label: "Cash taken on bills", paise: c.cashSalesPaise, sign: "+" },
    { label: "Old dues paid in cash", paise: c.cashCollectionsPaise, sign: "+" },
    { label: "Cash put in the drawer", paise: c.cashAddedPaise, sign: "+" },
    { label: "Supplier payments reversed", paise: c.supplierCashReturnedPaise, sign: "+" },
    { label: "Cash refunds", paise: c.cashRefundsPaise, sign: "−" },
    { label: "Paid to suppliers in cash", paise: c.supplierCashPaidPaise, sign: "−" },
    { label: "Shop expenses in cash", paise: c.cashExpensesPaise, sign: "−" },
    { label: "Taken out (bank deposit, owner)", paise: c.cashWithdrawnPaise, sign: "−" },
  ];

  return (
    <PageContainer>
      <PageIntro description="Cash in and out of the drawer for one day, from the bills, refunds, supplier payments and expenses already recorded. UPI, card, bank and credit are shown separately." />

      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/cashbook?date=${shift(book.date, -1)}`} className={buttonVariants({ variant: "outline", size: "touch" })} aria-label="Previous day">
          <ChevronLeft aria-hidden="true" />
        </Link>
        <form action="/cashbook" className="flex items-center gap-2">
          <label>
            <span className="sr-only">Date</span>
            <Input type="date" name="date" defaultValue={book.date} max={book.today} className="h-11" />
          </label>
          <button type="submit" className={buttonVariants({ variant: "outline", size: "touch" })}>
            Show
          </button>
        </form>
        {book.date < book.today ? (
          <Link href={`/cashbook?date=${shift(book.date, 1)}`} className={buttonVariants({ variant: "outline", size: "touch" })} aria-label="Next day">
            <ChevronRight aria-hidden="true" />
          </Link>
        ) : null}
        {book.date !== book.today ? (
          <Link href="/cashbook" className="text-sm font-semibold text-teal-strong hover:underline">
            Today
          </Link>
        ) : null}
      </div>

      <section className="grid gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:grid-cols-3 sm:p-6">
        <div className="sm:col-span-1">
          <p className="text-sm text-panel-muted">{dateText(book.date)}</p>
          <p className="mt-1 flex items-center gap-2 text-sm">
            {book.closed ? (
              <>
                <Lock className="size-4" aria-hidden="true" /> Closed by {book.closing?.closedByName}
              </>
            ) : (
              "Open"
            )}
          </p>
        </div>
        <div>
          <p className="text-sm text-panel-muted">Expected in drawer</p>
          <p className="text-3xl font-bold">
            <Money paise={book.expectedPaise} withPaise />
          </p>
        </div>
        {book.closed && book.closing ? (
          <div>
            <p className="text-sm text-panel-muted">Counted</p>
            <p className="text-3xl font-bold">
              <Money paise={book.closing.countedCashPaise} withPaise />
            </p>
            <p className="text-sm text-panel-muted">
              {book.closing.differencePaise === 0 ? (
                "Drawer matched"
              ) : (
                <>
                  {book.closing.differencePaise < 0 ? "Short " : "Extra "}
                  <Money paise={Math.abs(book.closing.differencePaise)} withPaise />: {book.closing.differenceReason}
                </>
              )}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-sm text-panel-muted">Sales today (all methods)</p>
            <p className="text-3xl font-bold">
              <Money paise={book.sales.salesPaise} />
            </p>
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Cash drawer" description={book.openingFromClosedDate ? `Opening is the cash counted when ${dateText(book.openingFromClosedDate)} was closed, plus any days since.` : "Opening starts from the shop's opening cash, plus every day since that was not closed."}>
          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="font-medium text-foreground">Opening cash</dt>
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
              <dt>Expected in drawer</dt>
              <dd>
                <Money paise={book.expectedPaise} withPaise />
              </dd>
            </div>
          </dl>
        </SectionCard>

        <SectionCard title="Not cash" description="These never go into the drawer. Cash flow is not profit.">
          <dl className="flex flex-col gap-1.5 text-sm">
            {book.nonCash.length === 0 ? <p className="text-muted-foreground">No UPI, card, bank or cheque payments.</p> : null}
            {book.nonCash.map((row) => (
              <div key={row.method} className="flex justify-between gap-3">
                <dt className="text-foreground">{METHOD[row.method] ?? row.method}</dt>
                <dd className="text-right tabular-nums">
                  {row.inPaise ? (
                    <span>
                      in <Money paise={row.inPaise} withPaise />
                    </span>
                  ) : null}
                  {row.inPaise && row.outPaise ? " · " : ""}
                  {row.outPaise ? (
                    <span>
                      out <Money paise={row.outPaise} withPaise />
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
            <div className="mt-2 flex justify-between gap-3 border-t border-border pt-2">
              <dt className="text-foreground">Sold on credit (added to dues)</dt>
              <dd>
                <Money paise={book.sales.creditGivenPaise} withPaise />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Sales ({book.sales.billCount} {book.sales.billCount === 1 ? "bill" : "bills"}, GST included)</dt>
              <dd>
                <Money paise={book.sales.salesPaise} withPaise />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Credit notes</dt>
              <dd>
                <Money paise={book.sales.creditNotesPaise} withPaise />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Goods received from suppliers</dt>
              <dd>
                <Money paise={book.purchases.purchasesPaise} withPaise />
              </dd>
            </div>
          </dl>
        </SectionCard>
      </div>

      <SectionCard title="Everything recorded this day" description="Tap an entry to open its bill, return or supplier." flush>
        {book.payments.length + book.expenses.length + book.movements.length + book.sales.creditBills.length === 0 ? (
          <p className="px-5 pb-3 text-sm text-muted-foreground">Nothing recorded on this day.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {book.payments.map((payment) => {
              const href = payment.creditNoteId ? `/billing/returns/${payment.creditNoteId}` : payment.invoiceId ? `/billing/invoices/${payment.invoiceId}` : payment.partyType === "supplier" && payment.partyId ? `/suppliers/${payment.partyId}` : null;
              const into = payment.direction === "in";
              const body = (
                <>
                  <span className="min-w-0">
                    <span className="block text-foreground">{PAYMENT_LABEL[payment.category]}</span>
                    <span className="block text-xs text-muted-foreground">
                      {METHOD[payment.method]}
                      {payment.reference ? ` · ${payment.reference}` : ""}
                      {payment.status === "reversed" ? " · later reversed" : ""}
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
                    <span className="block text-foreground">{bill.number} on credit</span>
                    <span className="block text-xs text-muted-foreground">Not money: added to the customer&apos;s dues</span>
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
                    {CATEGORY[expense.category]}
                    {expense.note ? `: ${expense.note}` : ""}
                    {expense.status === "voided" ? <Badge variant="neutral" className="ml-2">Voided</Badge> : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Expense · {METHOD[expense.method]}
                    {expense.reference ? ` · ${expense.reference}` : ""} · {expense.createdByName}
                    {expense.status === "voided" ? ` · voided: ${expense.voidReason}` : ""}
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
                  <span className="block text-foreground">{MOVEMENT_LABEL[movement.kind]}</span>
                  <span className="block text-xs text-muted-foreground">
                    Cash · {movement.createdByName}
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
            <SectionCard title="Add an expense" description="Tea, transport, rent… Cash expenses come out of the drawer.">
              <ExpenseForm date={book.date} />
              <ScrollIntoViewOnHash anchorId="section-add-an-expense" />
            </SectionCard>
            <SectionCard title="Cash in or out" description="Bank deposits, cash the owner takes, or change put in.">
              <CashMovementForm date={book.date} />
            </SectionCard>
          </>
        ) : null}
        {book.canClose ? (
          <SectionCard title="Close the day" description="Count the drawer. Any difference needs a reason.">
            <CloseDayForm date={book.date} expectedPaise={book.expectedPaise} />
          </SectionCard>
        ) : book.canReopen ? (
          <SectionCard title="Day closed" description="Bills, payments and expenses for this day are locked. Reopening is logged.">
            <ReopenDayForm date={book.date} />
          </SectionCard>
        ) : book.closed ? (
          <SectionCard title="Day closed" description="Only the owner can reopen it." >
            <p className="text-sm text-muted-foreground">Record new expenses or cash movements on today&apos;s date.</p>
          </SectionCard>
        ) : null}
      </div>

      {closings.length > 0 ? (
        <SectionCard title="Recent closings" flush>
          <ul className="flex flex-col divide-y divide-border text-sm">
            {closings.map((closing) => (
              <li key={closing.businessDate}>
                <Link href={`/cashbook?date=${closing.businessDate}`} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-muted/50">
                  <span>
                    {dateText(closing.businessDate)}
                    {closing.status === "reopened" ? <Badge variant="warning" className="ml-2">Reopened</Badge> : null}
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
