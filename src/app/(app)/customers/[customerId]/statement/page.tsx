import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PrintButton } from "@/components/sales/invoice-actions";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getCustomerAccount } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { ConflictError, NotFoundError } from "@/server/errors";

export const metadata: Metadata = { title: "Statement" };

type Props = PageProps<"/customers/[customerId]/statement">;

export default function StatementPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="customers.view" title="Statement">
      <Statement params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

async function Statement({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ customerId }, query] = await Promise.all([params, searchParams]);
  const account = await getCustomerAccount(await requireSession(), customerId, { from: String(query.from ?? ""), to: String(query.to ?? "") }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof ConflictError) return null;
    throw error;
  });
  if (!account) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title="Customer not found">
          <Link href="/customers" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to customers
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }
  const { customer, shop } = account;
  return (
    <PageContainer className="max-w-4xl print:max-w-none print:p-0">
      <div className="flex justify-between gap-3 print:hidden">
        <Link href={`/customers/${customer.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {customer.name}
        </Link>
        <PrintButton />
      </div>
      <article className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 text-sm sm:p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:justify-between">
          <div>
            <p className="text-lg font-bold text-foreground">{shop.legalName ?? shop.name}</p>
            {shop.gstin ? <p className="text-muted-foreground">GSTIN {shop.gstin}</p> : null}
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Statement of account</p>
            <p className="font-semibold text-foreground">{customer.name}</p>
            <p className="text-muted-foreground">
              {account.from ? dateText(account.from) : "From the start"} – {dateText(account.to ?? account.asOf)}
            </p>
          </div>
        </header>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1.5 font-medium">Date</th>
              <th className="py-1.5 font-medium">Entry</th>
              <th className="py-1.5 text-right font-medium">Debit</th>
              <th className="py-1.5 text-right font-medium">Credit</th>
              <th className="py-1.5 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {account.from ? (
              <tr>
                <td className="py-1.5">{dateText(account.from)}</td>
                <td colSpan={3}>Brought forward</td>
                <td className="text-right">
                  <Money paise={account.broughtForwardPaise} withPaise />
                </td>
              </tr>
            ) : null}
            {account.statement.map((line) => (
              <tr key={line.id}>
                <td className="py-1.5 whitespace-nowrap">{dateText(line.entryDate)}</td>
                <td>{line.description}</td>
                <td className="text-right">{line.debitPaise ? <Money paise={line.debitPaise} withPaise /> : ""}</td>
                <td className="text-right">{line.creditPaise ? <Money paise={line.creditPaise} withPaise /> : ""}</td>
                <td className="text-right">
                  <Money paise={line.balancePaise} withPaise />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="self-end text-base font-bold text-foreground">
          {account.balancePaise < 0 ? "Advance held: " : "Balance due: "}
          <Money paise={Math.abs(account.balancePaise)} withPaise />
        </p>
      </article>
    </PageContainer>
  );
}
