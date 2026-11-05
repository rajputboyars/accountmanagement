import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { PrintButton } from "@/components/sales/invoice-actions";
import { Badge } from "@/components/ui/badge";
import { getDeliveryChallan } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getLanguage, getT } from "@/server/i18n";
import { billDate, systemName } from "@/shared/i18n/labels";
import { unitShort } from "@/shared/i18n/unit-labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("orders.challan.title") };
}

type Props = { params: Promise<{ challanId: string }> };

export default function ChallanPage({ params }: Props) {
  return (
    <ProtectedPage permission="billing.view" title="Delivery challan">
      <Challan params={params} />
    </ProtectedPage>
  );
}

/** A delivery challan to print: no prices, just what left, from where, for whom, with a place to sign. */
async function Challan({ params }: Props) {
  const { challanId } = await params;
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const challan = await getDeliveryChallan(session, challanId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!challan) return null;
  return (
    <PageContainer className="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/billing/orders/${challan.order.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {challan.order.number}
        </Link>
        <PrintButton />
      </div>
      <article className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 sm:p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("orders.challan.to")}</p>
            <p className="text-lg font-bold text-foreground">{challan.customer.name}</p>
            <p className="text-sm text-muted-foreground">
              {challan.customer.area ?? ""}
              {challan.customer.phone ? ` · ${challan.customer.phone}` : ""}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{challan.shop.legalName ?? challan.shop.name}</p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("orders.challan.title")}</p>
            <p className="text-lg font-bold text-foreground">{challan.number}</p>
            <p className="text-sm text-muted-foreground">{billDate(challan.deliveryDate, language)}</p>
            <p className="text-sm text-muted-foreground">{challan.order.number}</p>
            {challan.godownName ? <p className="text-sm text-muted-foreground">{t("orders.challan.from", { godown: challan.godownName === "Main Store" ? t("godown.mainStore") : challan.godownName })}</p> : null}
            {challan.status === "cancelled" ? <Badge variant="danger" className="mt-1">{t("orders.challan.cancelled")}</Badge> : null}
          </div>
        </header>
        <table className="stack-table w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 pr-2 font-medium">{t("common.item")}</th>
              <th className="py-2 text-right font-medium">{t("common.qty")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {challan.lines.map((line) => (
              <tr key={line.id}>
                <td data-title className="py-2 pr-2 font-medium text-foreground">{line.productName}</td>
                <td data-key data-label={t("common.qty")} className="py-2 text-right whitespace-nowrap tabular-nums">
                  {line.qty} {unitShort(t, line.unit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {challan.note ? <p className="text-sm text-muted-foreground">{challan.note}</p> : null}
        <footer className="mt-8 flex justify-between gap-8 text-xs text-muted-foreground">
          <span>{systemName(challan.createdByName, language)}</span>
          <span className="min-w-48 border-t border-border pt-1 text-right">{t("orders.challan.sign")}</span>
        </footer>
      </article>
    </PageContainer>
  );
}
