import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { OrderForm } from "@/components/sales/order-form";
import { listBillingCustomers, listBillingGodowns } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("orders.new") };
}

export default function NewOrderPage() {
  return (
    <ProtectedPage permission="billing.create" title="New order">
      <NewOrder />
    </ProtectedPage>
  );
}

async function NewOrder() {
  const session = await requireSession();
  const t = await getT();
  const [customers, godowns] = await Promise.all([listBillingCustomers(session), listBillingGodowns(session)]);
  return (
    <PageContainer className="max-w-3xl">
      <Link href="/billing/orders" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("orders.back")}
      </Link>
      <PageIntro description={t("orders.intro")} />
      <SectionCard title={t("orders.new")}>
        <OrderForm customers={customers.map((customer) => ({ id: customer.id, name: customer.name }))} godowns={godowns.length > 1 ? godowns.map((godown) => ({ id: godown.id, name: godown.isDefault && godown.name === "Main Store" ? t("godown.mainStore") : godown.name })) : undefined} />
      </SectionCard>
    </PageContainer>
  );
}
