import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PrintButton } from "@/components/sales/invoice-actions";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getSupplierStatement } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";

export const metadata: Metadata = { title: "Supplier statement" };

type Props = PageProps<"/suppliers/[supplierId]/statement">;

export default function SupplierStatementPage({ params }: Props) {
  return (
    <ProtectedPage permission="purchases.view" title="Supplier statement">
      <Statement params={params} />
    </ProtectedPage>
  );
}

const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

async function Statement({ params }: Pick<Props, "params">) {
  const { supplierId } = await params;
  const data = await getSupplierStatement(await requireSession(), supplierId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!data) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title="Supplier not found">
          <Link href="/suppliers" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to suppliers
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }
  return (
    <PageContainer className="max-w-4xl print:max-w-none print:p-0">
      <div className="flex justify-between gap-3 print:hidden">
        <Link href={`/suppliers/${data.supplier.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {data.supplier.name}
        </Link>
        <PrintButton />
      </div>
      <article className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 text-sm sm:p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-col gap-1 border-b border-border pb-4 sm:flex-row sm:justify-between">
          <p className="text-lg font-bold text-foreground">{data.shop.legalName ?? data.shop.name}</p>
          <div className="sm:text-right">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Supplier statement · {dateText(data.asOf)}</p>
            <p className="font-semibold text-foreground">{data.supplier.name}</p>
          </div>
        </header>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1.5 font-medium">Date</th>
              <th className="py-1.5 font-medium">Entry</th>
              <th className="py-1.5 text-right font-medium">Bought</th>
              <th className="py-1.5 text-right font-medium">Paid</th>
              <th className="py-1.5 text-right font-medium">You owe</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.statement.map((line) => (
              <tr key={line.id}>
                <td className="py-1.5 whitespace-nowrap">{dateText(line.entryDate)}</td>
                <td>{line.description}</td>
                <td className="text-right">{line.creditPaise ? <Money paise={line.creditPaise} withPaise /> : ""}</td>
                <td className="text-right">{line.debitPaise ? <Money paise={line.debitPaise} withPaise /> : ""}</td>
                <td className="text-right">
                  <Money paise={line.owedAfterPaise} withPaise />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.ageing.open.length > 0 ? (
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Unpaid bills (oldest first)</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {data.ageing.open.map((item) => (
                <li key={item.id} className="flex justify-between gap-3">
                  <span>
                    {item.label} · due {dateText(item.dueDate)}
                    {item.daysPastDue ? ` · ${item.daysPastDue} days late` : ""}
                  </span>
                  <Money paise={item.remainingPaise} withPaise />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="self-end text-base font-bold text-foreground">
          You owe <Money paise={Math.max(data.owedPaise, 0)} withPaise />
        </p>
      </article>
    </PageContainer>
  );
}
