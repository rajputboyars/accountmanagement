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
import { ConflictError, NotFoundError } from "@/server/errors";
import { formatPaise } from "@/shared/money";
import { addDays } from "@/shared/report-range";

export const metadata: Metadata = { title: "Customer" };

type Props = PageProps<"/customers/[customerId]">;

export default function CustomerPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="customers.view" title="Customer">
      <Account params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const METHOD: Record<string, string> = { cash: "Cash", upi: "UPI", bank: "Bank", cheque: "Cheque", card: "Card" };
/** How each ledger entry reads on a phone: bills add to the balance, payments and cancellations reduce it. */
const ENTRY: Record<string, { label: string; variant: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  opening: { label: "Opening", variant: "neutral" },
  invoice: { label: "Bill", variant: "info" },
  payment: { label: "Payment", variant: "success" },
  credit_note: { label: "Return", variant: "warning" },
  cancellation: { label: "Cancelled", variant: "warning" },
  correction: { label: "Adjustment", variant: "neutral" },
};

const WHATSAPP_STATUS: Record<string, { label: string; variant: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  queued: { label: "Queued", variant: "neutral" },
  sending: { label: "Sending", variant: "warning" },
  sent: { label: "Sent", variant: "info" },
  delivered: { label: "Delivered", variant: "success" },
  read: { label: "Read", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
};
const timeText = (date: Date) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(date);

async function Account({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ customerId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const account = await getCustomerAccount(session, customerId, { from: String(query.from ?? ""), to: String(query.to ?? "") }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof ConflictError) return null;
    throw error;
  });
  const messages = account ? await listWhatsAppMessages(session, account.customer.id) : { rows: [] };
  if (!account) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title="Customer not found" description="It may belong to a different shop.">
          <Link href="/customers" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to customers
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
        Customers
      </Link>
      <section className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <div className="min-w-0">
          <h2 className="text-xl font-bold sm:text-2xl">{customer.name}</h2>
          <p className="text-sm text-panel-muted">
            {customer.type === "wholesale" ? "Wholesale" : "Retail"}
            {customer.phone ? ` · ${customer.phone}` : ""} · credit limit <Money paise={customer.creditLimitPaise} />
          </p>
          {account.tone === "red" ? <Badge variant="danger" className="mt-1">Overdue</Badge> : null}
        </div>
        <div className="sm:text-right">
          <p className="text-sm text-panel-muted">{account.balancePaise < 0 ? "Advance held" : "Owes you"}</p>
          <p className="text-3xl font-bold">
            <Money paise={Math.abs(account.balancePaise)} withPaise />
          </p>
          <p className="text-sm text-panel-muted">
            Credit still available <Money paise={account.availableCreditPaise} />
          </p>
        </div>
      </section>

      <dl aria-label="Account summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Total outstanding", value: <Money paise={account.summary.outstandingPaise} withPaise />, note: account.balancePaise < 0 ? "Advance held" : "Baaki (udhaar)" },
          { label: "Overdue", value: <Money paise={account.summary.overduePaise} withPaise />, note: "Bills older than 30 days", tone: account.summary.overduePaise > 0 ? "text-danger" : "" },
          {
            label: "Oldest unpaid bill",
            value: account.summary.oldestUnpaid ? `${account.summary.oldestUnpaid.ageDays} days` : "None",
            note: account.summary.oldestUnpaid ? `${account.summary.oldestUnpaid.label} · ${dateText(account.summary.oldestUnpaid.date)}` : "All bills paid",
          },
          {
            label: "Last payment",
            value: account.summary.lastPayment ? <Money paise={account.summary.lastPayment.amountPaise} withPaise /> : "None yet",
            note: account.summary.lastPayment ? dateText(account.summary.lastPayment.date) : "No payment recorded",
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
        <div className="flex flex-col gap-6">
          <SectionCard title="Unpaid bills" description="Payments are applied to the oldest bill first. A bill is overdue after 30 days." flush>
            {account.ageing.open.length === 0 ? (
              <p className="px-5 pb-3 text-sm text-muted-foreground">{account.balancePaise < 0 ? "Nothing due; the advance will be used on the next bill." : "Nothing due. Paid up."}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border text-sm">
                {account.ageing.open.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                    <span>
                      <span className="block text-foreground">{item.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {dateText(item.date)} · {item.ageDays} days old{item.daysPastDue > 0 ? ` · ${item.daysPastDue} days overdue` : ""}
                      </span>
                    </span>
                    <span className="text-right">
                      <Money paise={item.remainingPaise} withPaise className="font-semibold" />
                      {item.remainingPaise !== item.amountPaise ? (
                        <span className="block text-xs text-muted-foreground">
                          of <Money paise={item.amountPaise} withPaise />
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Statement"
            description="Every entry with the balance after it."
            action={
              <div className="flex gap-1">
                <Link href={`/customers/${customer.id}/statement${range ? `?${range}` : ""}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  <Printer aria-hidden="true" />
                  Print
                </Link>
                <a href={`/customers/${customer.id}/statement/csv${range ? `?${range}` : ""}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  <Download aria-hidden="true" />
                  CSV
                </a>
              </div>
            }
            flush
          >
            <div className="flex flex-wrap gap-2 px-5 pb-3 text-sm" aria-label="Show entries from">
              {[
                { label: "All", href: `/customers/${customer.id}`, active: !account.from && !account.to },
                { label: "This month", href: `/customers/${customer.id}?from=${account.asOf.slice(0, 8)}01`, active: account.from === `${account.asOf.slice(0, 8)}01` && !account.to },
                { label: "Last 30 days", href: `/customers/${customer.id}?from=${addDays(account.asOf, -29)}`, active: account.from === addDays(account.asOf, -29) && !account.to },
              ].map((item) => (
                <Link key={item.label} href={item.href} aria-current={item.active ? "true" : undefined} className={buttonVariants({ variant: item.active ? "default" : "outline", size: "sm" })}>
                  {item.label}
                </Link>
              ))}
              {account.ageing.open.length > 0 ? (
                <a href="#section-unpaid-bills" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Unpaid bills ({account.ageing.open.length})
                </a>
              ) : null}
            </div>
            <form action={`/customers/${customer.id}`} className="flex flex-wrap items-end gap-2 px-5 pb-3 text-sm">
              <label className="flex flex-col gap-1">
                From
                <input type="date" name="from" defaultValue={account.from ?? ""} className="h-10 rounded-lg border border-input bg-background px-2" />
              </label>
              <label className="flex flex-col gap-1">
                To
                <input type="date" name="to" defaultValue={account.to ?? ""} className="h-10 rounded-lg border border-input bg-background px-2" />
              </label>
              <button type="submit" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Show
              </button>
            </form>
            <ul className="flex flex-col divide-y divide-border border-t border-border text-sm sm:hidden">
              {account.from ? (
                <li className="flex items-center justify-between gap-3 px-5 py-2.5 text-muted-foreground">
                  <span>Brought forward · {dateText(account.from)}</span>
                  <Money paise={account.broughtForwardPaise} withPaise />
                </li>
              ) : null}
              {account.statement.length === 0 ? <li className="px-5 py-4 text-muted-foreground">No entries in these dates.</li> : null}
              {account.statement.map((line) => (
                <li key={line.id} className="flex items-start justify-between gap-3 px-5 py-2.5">
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={ENTRY[line.kind]?.variant ?? "neutral"}>{ENTRY[line.kind]?.label ?? line.kind}</Badge>
                      {line.href ? (
                        <Link href={line.href} className="truncate text-teal-strong hover:underline">
                          {line.description}
                        </Link>
                      ) : (
                        <span className="truncate text-foreground">{line.description}</span>
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
                      Balance <Money paise={line.balancePaise} withPaise />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="border-y border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Entry</th>
                    <th className="px-3 py-2 text-right font-medium">Debit</th>
                    <th className="px-3 py-2 text-right font-medium">Credit</th>
                    <th className="px-5 py-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {account.from ? (
                    <tr>
                      <td className="px-5 py-2 text-muted-foreground">{dateText(account.from)}</td>
                      <td className="px-3 py-2 text-muted-foreground" colSpan={3}>
                        Brought forward
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
                            {line.description}
                          </Link>
                        ) : (
                          line.description
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

          <SectionCard title="Receipts" flush>
            {account.receipts.length === 0 ? (
              <p className="px-5 pb-3 text-sm text-muted-foreground">No receipts yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border text-sm">
                {account.receipts.map((receipt) => (
                  <li key={receipt.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                    <span>
                      <span className="font-medium text-foreground">{receipt.receiptNumber}</span> · {METHOD[receipt.method]} · {dateText(receipt.businessDate)}
                      {receipt.reference ? ` · ${receipt.reference}` : ""}
                      {receipt.status === "reversed" ? <Badge variant="neutral" className="ml-2">Reversed</Badge> : null}
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

        <div className="flex flex-col gap-6">
          {account.canRecord ? (
            <SectionCard title="Record a payment" description="Money received against dues. It's applied to the oldest bills first.">
              <ReceiptForm customerId={customer.id} balanceText={formatPaise(account.balancePaise, { withPaise: true })} />
              <ScrollIntoViewOnHash anchorId="section-record-a-payment" />
            </SectionCard>
          ) : null}
          {account.canRecord && account.balancePaise > 0 ? (
            <SectionCard title="Payment reminder" description={customer.whatsappConsent ? "Only this customer's own balance is included." : "The customer hasn't agreed to WhatsApp reminders."}>
              {customer.whatsappConsent && customer.phone ? <ReminderCard customerId={customer.id} /> : <p className="text-sm text-muted-foreground">Turn on consent in the details below only if the customer agreed.</p>}
            </SectionCard>
          ) : null}
          {messages.rows.length > 0 ? (
            <SectionCard title="WhatsApp messages" description="Sent means WhatsApp accepted it; delivered and read come from WhatsApp." flush>
              <ul className="flex flex-col divide-y divide-border pb-2">
                {messages.rows.map((message) => (
                  <li key={message.id} className="flex flex-col gap-0.5 px-5 py-2.5 text-sm">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-foreground">Dues reminder · {timeText(message.createdAt)}</span>
                      <Badge variant={WHATSAPP_STATUS[message.status]?.variant ?? "neutral"}>{WHATSAPP_STATUS[message.status]?.label ?? message.status}</Badge>
                    </span>
                    {message.lastError ? <span className="text-xs text-muted-foreground">{message.lastError}</span> : null}
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
          {account.canEdit ? (
            <SectionCard title="Details">
              <CustomerForm customer={customer} />
            </SectionCard>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}
