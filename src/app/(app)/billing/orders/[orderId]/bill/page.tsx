import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { ChallanBillForm } from "@/components/sales/challan-bill-form";
import { listBankChoices } from "@/modules/accounting";
import { listBillableDeliveries } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getT } from "@/server/i18n";
import { unitShort } from "@/shared/i18n/unit-labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("orders.bill.title") };
}

type Props = { params: Promise<{ orderId: string }> };

export default function BillDeliveredPage({ params }: Props) {
  return (
    <ProtectedPage permission="billing.create" title="Bill delivered goods">
      <BillDelivered params={params} />
    </ProtectedPage>
  );
}

async function BillDelivered({ params }: Props) {
  const { orderId } = await params;
  const session = await requireSession();
  const t = await getT();
  const delivered = await listBillableDeliveries(session, orderId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!delivered) return null;
  return (
    <PageContainer className="max-w-3xl">
      <Link href={`/billing/orders/${orderId}`} className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {delivered.orderNumber}
      </Link>
      <PageIntro description={t("orders.bill.intro")} />
      <SectionCard title={`${t("orders.bill.title")}: ${delivered.customerName}`}>
        {delivered.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("orders.bill.nothing")}</p>
        ) : (
          <ChallanBillForm bankAccounts={await listBankChoices(session).catch(() => [])} customerId={delivered.customerId} lines={delivered.lines.map((line) => ({ ...line, unit: line.unit, deliveredQty: line.deliveredQty, billedQty: line.billedQty, remainingQty: line.remainingQty, productName: `${line.productName} (${unitShort(t, line.unit)})` }))} />
        )}
      </SectionCard>
    </PageContainer>
  );
}
