import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Download, Printer } from "lucide-react";
import { CustomerForm, ReceiptForm, ReminderCard, ReverseReceipt } from "@/components/customers/customer-forms";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { ScrollIntoViewOnHash } from "@/components/nexora/scroll-into-view";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getCustomerAccount, listWhatsAppMessages } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { LANGUAGE_NAMES, translateServerMessage, type MessageKey } from "@/shared/i18n";
import { billDate, statementLabel, timeLabel } from "@/shared/i18n/labels";
import { ConflictError, NotFoundError } from "@/server/errors";
import { formatPaise } from "@/shared/money";
import { addDays } from "@/shared/report-range";
import { HelpHint } from "@/components/nexora/help-hint";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.customer") };
}

type Props = PageProps<"/customers/[customerId]">;

export default function CustomerPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="customers.view" title="Customer" guide="payments">
      <Account params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const METHOD: Record<string, MessageKey> = { cash: "common.cash", upi: "common.upi", bank: "common.bank", cheque: "common.cheque", card: "common.card" };
/** How each ledger entry reads on a phone: bills add to the balance, payments and cancellations reduce it. */
const ENTRY: Record<string, { label: MessageKey; variant: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  opening: { label: "entry.opening", variant: "neutral" },
  invoice: { label: "entry.invoice", variant: "info" },
  payment: { label: "entry.payment", variant: "success" },
  credit_note: { label: "entry.creditNote", variant: "warning" },
  cancellation: { label: "entry.cancellation", variant: "warning" },
  correction: { label: "entry.correction", variant: "neutral" },
};

const WHATSAPP_STATUS: Record<string, { label: MessageKey; variant: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  queued: { label: "whatsapp.queued", variant: "neutral" },
  sending: { label: "whatsapp.sending", variant: "warning" },
  sent: { label: "whatsapp.sent", variant: "info" },
  delivered: { label: "whatsapp.delivered", variant: "success" },
  read: { label: "whatsapp.read", variant: "success" },
  failed: { label: "whatsapp.failed", variant: "danger" },
};

async function Account({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ customerId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const dateText = (value: string) => billDate(value, language);
  const days = (count: number) => t("common.days", { count });
  const account = await getCustomerAccount(session, customerId, { from: String(query.from ?? ""), to: String(query.to ?? "") }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof ConflictError) return null;
    throw error;
  });
  const messages = account ? await listWhatsAppMessages(session, account.customer.id) : { rows: [] };
  if (!account) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t("customers.notFound")} description={t("customers.notFoundHelp")}>
          <Link href="/customers" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("customers.back")}
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }
  const { customer } = account;
  const range = `${account.from ? `from=${account.from}&` : ""}${account.to ? `to=${account.to}` : ""}`;

  return (
    <PageContainer className="max-w-6xl">
      <Link href="/customers" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("page.customers")}
      </Link>
      <section className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <div className="min-w-0">
          <h2 className="text-xl font-bold sm:text-2xl">{customer.name}</h2>
          <p className="text-sm text-panel-muted">
            {t(customer.type === "wholesale" ? "common.wholesale" : "common.retail")}
            {customer.phone ? ` · ${customer.phone}` : ""} · {t("customers.creditLimit")}<Money paise={customer.creditLimitPaise} />
          </p>
          <p className="text-sm text-panel-muted">{t("customers.messageLanguageLine", { language: customer.communicationLanguage ? LANGUAGE_NAMES[customer.communicationLanguage] : t("customers.languageNotSet") })}</p>
          {account.tone === "red" ? <span className="mt-1 flex items-center gap-1"><Badge variant="danger">{t("customers.overdue")}</Badge><HelpHint topic="overdue" /></span> : null}
        </div>
        <div className="sm:text-right">
          <p className="flex items-center gap-1 text-sm text-panel-muted sm:justify-end">{t(account.balancePaise < 0 ? "customers.advanceHeld" : "customers.outstanding")}<HelpHint topic={account.balancePaise < 0 ? "advancePayment" : "outstanding"} /></p>
          <p data-guide="customer-balance" className="text-3xl font-bold">
            <Money paise={Math.abs(account.balancePaise)} withPaise />
          </p>
          <p className="text-sm text-panel-muted">
            {t("customers.creditAvailable")}<Money paise={account.availableCreditPaise} />
          </p>
        </div>
      </section>

      <dl aria-label={t("customers.summary")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: t("customers.totalOutstanding"), value: <Money paise={account.summary.outstandingPaise} withPaise />, note: t(account.balancePaise < 0 ? "customers.advanceHeld" : "customers.unpaidOnCredit") },
          { label: t("customers.overdue"), value: <Money paise={account.summary.overduePaise} withPaise />, note: t("customers.olderThan30"), tone: account.summary.overduePaise > 0 ? "text-danger" : "" },
          {
            label: t("customers.oldestUnpaid"),
            value: account.summary.oldestUnpaid ? days(account.summary.oldestUnpaid.ageDays) : t("common.none"),
            note: account.summary.oldestUnpaid ? `${statementLabel(account.summary.oldestUnpaid.label, language)} · ${dateText(account.summary.oldestUnpaid.date)}` : t("customers.allPaid"),
          },
          {
            label: t("customers.lastPayment"),
            value: account.summary.lastPayment ? <Money paise={account.summary.lastPayment.amountPaise} withPaise /> : t("customers.noneYet"),
            note: account.summary.lastPayment ? dateText(account.summary.lastPayment.date) : t("customers.noPayment"),
          },
        ].map((item) => (
          <div key={item.label} className="flex min-w-0 flex-col gap-0.5 rounded-2xl border border-border bg-card p-4">
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className={`text-lg font-semibold text-foreground tabular-nums ${item.tone ?? ""}`}>{item.value}</dd>
            <dd className="truncate text-xs text-muted-foreground">{item.note}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <SectionCard title={t("customers.unpaidBills")} anchorId="section-unpaid-bills" description={t("customers.unpaidBillsHelp")} flush>
            {account.ageing.open.length === 0 ? (
              <p className="px-5 pb-3 text-sm text-muted-foreground">{t(account.balancePaise < 0 ? "customers.nothingDueAdvance" : "customers.nothingDue")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border text-sm">
                {account.ageing.open.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                    <span>
                      <span className="block text-foreground">{statementLabel(item.label, language)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {dateText(item.date)} · {t("customers.daysOld", { days: item.ageDays })}{item.daysPastDue > 0 ? ` · ${t("customers.daysOverdue", { days: item.daysPastDue })}` : ""}
                      </span>
                    </span>
                    <span className="text-right">
                      <Money paise={item.remainingPaise} withPaise className="font-semibold" />
                      {item.remainingPaise !== item.amountPaise ? (
                        <span className="block text-xs text-muted-foreground">
                          {t("customers.ofAmount", { amount: formatPaise(item.amountPaise, { withPaise: true }) })}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title={t("statement.title")}
            description={t("customers.statementHelp")}
            action={
              <div className="flex gap-1">
                <Link href={`/customers/${customer.id}/statement${range ? `?${range}` : ""}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  <Printer aria-hidden="true" />
                  {t("common.print")}
                </Link>
                <a href={`/customers/${customer.id}/statement/csv${range ? `?${range}` : ""}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  <Download aria-hidden="true" />
                  CSV
                </a>
              </div>
            }
            flush
          >
            <div className="flex flex-wrap gap-2 px-5 pb-3 text-sm" aria-label={t("customers.showFrom")}>
              {[
                { label: t("common.all"), href: `/customers/${customer.id}`, active: !account.from && !account.to },
                { label: t("common.thisMonth"), href: `/customers/${customer.id}?from=${account.asOf.slice(0, 8)}01`, active: account.from === `${account.asOf.slice(0, 8)}01` && !account.to },
                { label: t("common.last30"), href: `/customers/${customer.id}?from=${addDays(account.asOf, -29)}`, active: account.from === addDays(account.asOf, -29) && !account.to },
              ].map((item) => (
                <Link key={item.label} href={item.href} aria-current={item.active ? "true" : undefined} className={buttonVariants({ variant: item.active ? "default" : "outline", size: "sm" })}>
                  {item.label}
                </Link>
              ))}
              {account.ageing.open.length > 0 ? (
                <a href="#section-unpaid-bills" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  {t("customers.unpaidCount", { count: account.ageing.open.length })}
                </a>
              ) : null}
            </div>
            <form action={`/customers/${customer.id}`} className="flex flex-wrap items-end gap-2 px-5 pb-3 text-sm">
              <label className="flex flex-col gap-1">
                {t("range.from")}
                <input type="date" name="from" defaultValue={account.from ?? ""} className="h-10 rounded-lg border border-input bg-background px-2" />
              </label>
              <label className="flex flex-col gap-1">
                {t("range.to")}
                <input type="date" name="to" defaultValue={account.to ?? ""} className="h-10 rounded-lg border border-input bg-background px-2" />
              </label>
              <button type="submit" className={buttonVariants({ variant: "outline", size: "sm" })}>
                {t("common.show")}
              </button>
            </form>
            <ul className="flex flex-col divide-y divide-border border-t border-border text-sm sm:hidden">
              {account.from ? (
                <li className="flex items-center justify-between gap-3 px-5 py-2.5 text-muted-foreground">
                  <span>{t("statement.broughtForwardOn", { date: dateText(account.from) })}</span>
                  <Money paise={account.broughtForwardPaise} withPaise />
                </li>
              ) : null}
              {account.statement.length === 0 ? <li className="px-5 py-4 text-muted-foreground">{t("statement.noEntriesDates")}</li> : null}
              {account.statement.map((line) => (
                <li key={line.id} className="flex items-start justify-between gap-3 px-5 py-2.5">
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={ENTRY[line.kind]?.variant ?? "neutral"}>{ENTRY[line.kind] ? t(ENTRY[line.kind]!.label) : line.kind}</Badge>
                      {line.href ? (
                        <Link href={line.href} className="truncate text-teal-strong hover:underline">
                          {statementLabel(line.description, language)}
                        </Link>
                      ) : (
                        <span className="truncate text-foreground">{statementLabel(line.description, language)}</span>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">{dateText(line.entryDate)}</span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    <span className={line.debitPaise ? "block font-semibold text-foreground" : "block font-semibold text-success"}>
                      {line.debitPaise ? "+" : "−"}
                      <Money paise={line.debitPaise || line.creditPaise} withPaise />
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t("statement.balanceAmount")}<Money paise={line.balancePaise} withPaise />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="border-y border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2 font-medium">{t("statement.date")}</th>
                    <th className="px-3 py-2 font-medium">{t("statement.entry")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("statement.debit")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("statement.credit")}</th>
                    <th className="px-5 py-2 text-right font-medium">{t("statement.balance")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {account.from ? (
                    <tr>
                      <td className="px-5 py-2 text-muted-foreground">{dateText(account.from)}</td>
                      <td className="px-3 py-2 text-muted-foreground" colSpan={3}>
                        {t("statement.broughtForward")}
                      </td>
                      <td className="px-5 py-2 text-right">
                        <Money paise={account.broughtForwardPaise} withPaise />
                      </td>
                    </tr>
                  ) : null}
                  {account.statement.map((line) => (
                    <tr key={line.id}>
                      <td className="px-5 py-2 whitespace-nowrap text-muted-foreground">{dateText(line.entryDate)}</td>
                      <td className="px-3 py-2">
                        {line.href ? (
                          <Link href={line.href} className="text-teal-strong hover:underline">
                            {statementLabel(line.description, language)}
                          </Link>
                        ) : (
                          statementLabel(line.description, language)
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">{line.debitPaise ? <Money paise={line.debitPaise} withPaise /> : ""}</td>
                      <td className="px-3 py-2 text-right">{line.creditPaise ? <Money paise={line.creditPaise} withPaise /> : ""}</td>
                      <td className="px-5 py-2 text-right font-medium">
                        <Money paise={line.balancePaise} withPaise />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          <SectionCard title={t("customers.receipts")} flush>
            {account.receipts.length === 0 ? (
              <p className="px-5 pb-3 text-sm text-muted-foreground">{t("customers.noReceipts")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border text-sm">
                {account.receipts.map((receipt) => (
                  <li key={receipt.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                    <span>
                      <span className="font-medium text-foreground">{receipt.receiptNumber}</span> · {METHOD[receipt.method] ? t(METHOD[receipt.method]!) : receipt.method} · {dateText(receipt.businessDate)}
                      {receipt.reference ? ` · ${receipt.reference}` : ""}
                      {receipt.status === "reversed" ? <Badge variant="neutral" className="ml-2">{t("status.reversed")}</Badge> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <Money paise={receipt.amountPaise} withPaise />
                      {account.canReverse && receipt.status === "recorded" ? <ReverseReceipt customerId={customer.id} paymentId={receipt.id} /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {account.canRecord ? (
            <SectionCard title={t("customers.recordTitle")} anchorId="section-record-a-payment" description={t("customers.recordHelp")}>
              <ReceiptForm customerId={customer.id} balanceText={formatPaise(account.balancePaise, { withPaise: true })} />
              <ScrollIntoViewOnHash anchorId="section-record-a-payment" />
            </SectionCard>
          ) : null}
          {account.canRecord && account.balancePaise > 0 ? (
            <SectionCard title={t("customers.reminder")} description={t(customer.whatsappConsent ? "customers.reminderHelp" : "customers.noConsent")}>
              {customer.whatsappConsent && customer.phone ? <ReminderCard customerId={customer.id} /> : <p className="text-sm text-muted-foreground">{t("customers.turnOnConsent")}</p>}
            </SectionCard>
          ) : null}
          {messages.rows.length > 0 ? (
            <SectionCard title={t("customers.whatsappMessages")} description={t("customers.whatsappHelp")} flush>
              <ul className="flex flex-col divide-y divide-border pb-2">
                {messages.rows.map((message) => (
                  <li key={message.id} className="flex flex-col gap-0.5 px-5 py-2.5 text-sm">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-foreground">{t("customers.reminderAt", { time: timeLabel(message.createdAt, language) })}</span>
                      <Badge variant={WHATSAPP_STATUS[message.status]?.variant ?? "neutral"}>{WHATSAPP_STATUS[message.status] ? t(WHATSAPP_STATUS[message.status]!.label) : message.status}</Badge>
                    </span>
                    {message.lastError ? <span className="text-xs text-muted-foreground">{translateServerMessage(message.lastError, language)}</span> : null}
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
          {account.canEdit ? (
            <SectionCard title={t("common.details")}>
              <CustomerForm customer={customer} />
            </SectionCard>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}
