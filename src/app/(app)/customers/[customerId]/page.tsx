import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Download, Printer } from "lucide-react";
import { CustomerForm, ReceiptForm, ReminderCard, ReverseReceipt } from "@/components/customers/customer-forms";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getCustomerAccount } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { ConflictError, NotFoundError } from "@/server/errors";
import { formatPaise } from "@/shared/money";

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

async function Account({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ customerId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const account = await getCustomerAccount(session, customerId, { from: String(query.from ?? ""), to: String(query.to ?? "") }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof ConflictError) return null;
    throw error;
  });
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
            <div className="overflow-x-auto">
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
            </SectionCard>
          ) : null}
          {account.canRecord && account.balancePaise > 0 ? (
            <SectionCard title="Payment reminder" description={customer.whatsappConsent ? "Only this customer's own balance is included." : "The customer hasn't agreed to WhatsApp reminders."}>
              {customer.whatsappConsent && customer.phone ? <ReminderCard customerId={customer.id} /> : <p className="text-sm text-muted-foreground">Turn on consent in the details below only if the customer agreed.</p>}
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
