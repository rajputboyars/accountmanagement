import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PurchaseReturnForm } from "@/components/purchases/purchase-return-form";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { listBankChoices } from "@/modules/accounting";
import { listGodowns } from "@/modules/inventory";
import { getGoodsReceipt, listReturnableLines } from "@/modules/purchasing";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getT } from "@/server/i18n";
import { unitShort } from "@/shared/i18n/unit-labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("purchases.return.title") };
}

type Props = { params: Promise<{ receiptId: string }> };

export default function ReturnPage({ params }: Props) {
  return (
    <ProtectedPage permission="purchases.edit" title="Return goods">
      <ReturnView params={params} />
    </ProtectedPage>
  );
}

async function ReturnView({ params }: Props) {
  const { receiptId } = await params;
  const session = await requireSession();
  const t = await getT();
  const receipt = await getGoodsReceipt(session, receiptId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!receipt) return null;
  const [returnable, places] = await Promise.all([listReturnableLines(session, receiptId), listGodowns(session).catch(() => [])]);
  const anyLeft = returnable.lines.some((line) => Number(line.remainingQty) > 0);
  return (
    <PageContainer className="max-w-3xl">
      <Link href={`/purchases/receipts/${receiptId}`} className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {receipt.number}
      </Link>
      <PageIntro description={t("purchases.return.intro", { supplier: receipt.supplier.name })} />
      <SectionCard title={t("purchases.return.title")}>
        {receipt.status === "cancelled" || !anyLeft ? (
          <p className="text-sm text-muted-foreground">{t("purchases.return.noneLeft")}</p>
        ) : (
          <PurchaseReturnForm
            bankAccounts={await listBankChoices(session).catch(() => [])}
            receiptId={receiptId}
            homeGodownId={returnable.godownId}
            canRefund={returnable.canRefund}
            godowns={places.length > 1 ? places.map((place) => ({ id: place.id, name: place.isDefault && place.name === "Main Store" ? t("godown.mainStore") : place.name })) : undefined}
            lines={returnable.lines.map((line) => ({ receiptLineId: line.receiptLineId, productName: line.productName, unit: unitShort(t, line.unit), receivedQty: line.receivedQty, returnedQty: line.returnedQty, remainingQty: line.remainingQty, unitCostPaise: line.unitCostPaise }))}
          />
        )}
      </SectionCard>
    </PageContainer>
  );
}
