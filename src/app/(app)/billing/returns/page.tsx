import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Undo2 } from "lucide-react";
import { FindInvoiceForm } from "@/components/sales/return-form";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { hasPermission } from "@/modules/identity";
import { BILLING_RETURN, listCreditNotes } from "@/modules/sales";
import { requireSession } from "@/server/auth";

export const metadata: Metadata = { title: "Returns" };

type Search = PageProps<"/billing/returns">["searchParams"];

export default function ReturnsPage({ searchParams }: PageProps<"/billing/returns">) {
  return (
    <ProtectedPage permission="billing.view" title="Returns">
      <Returns searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const SETTLEMENT: Record<string, string> = { ledger: "Dues reduced", cash: "Cash refund", upi: "UPI refund", bank: "Bank refund" };

async function Returns({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const session = await requireSession();
  const page = Math.max(1, Number.parseInt(one(params.page), 10) || 1);
  const [result, canReturn] = await Promise.all([listCreditNotes(session, { page }), hasPermission(session, BILLING_RETURN)]);
  const href = (target: number) => (target > 1 ? `/billing/returns?page=${target}` : "/billing/returns");

  return (
    <PageContainer>
      <PageIntro description="Goods brought back against a bill. Each return is a numbered credit note; the original bill is never changed." />
      {canReturn ? (
        <section className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
          <div className="flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-xl bg-panel-foreground/10">
              <Undo2 className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-bold">Start a return</h2>
              <p className="text-sm text-panel-muted">Find the bill the goods were sold on.</p>
            </div>
          </div>
          <div className="rounded-xl bg-card p-4 text-foreground">
            <FindInvoiceForm />
          </div>
        </section>
      ) : null}

      <SectionCard title="Credit notes" description="Newest first" flush>
        {result.items.length === 0 ? (
          <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">No returns yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {result.items.map((note) => (
              <li key={note.id}>
                <Link href={`/billing/returns/${note.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/50">
                  <span className="min-w-0">
                    <span className="block font-semibold text-foreground">{note.number}</span>
                    <span className="block text-xs text-muted-foreground">
                      {dateText(note.businessDate)} · {note.customerName} · against {note.invoiceNumber}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{note.reason}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <Money paise={note.totalPaise} withPaise className="font-semibold text-foreground" />
                    <Badge variant={note.settlement === "ledger" ? "info" : "warning"}>{SETTLEMENT[note.settlement]}</Badge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {result.page > 1 || result.hasMore ? (
          <nav aria-label="Pages" className="flex justify-between gap-2 border-t border-border px-5 pt-3">
            {result.page > 1 ? (
              <Link href={href(result.page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                <ChevronLeft aria-hidden="true" />
                Newer
              </Link>
            ) : (
              <span />
            )}
            {result.hasMore ? (
              <Link href={href(result.page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Older
                <ChevronRight aria-hidden="true" />
              </Link>
            ) : null}
          </nav>
        ) : null}
      </SectionCard>
    </PageContainer>
  );
}
