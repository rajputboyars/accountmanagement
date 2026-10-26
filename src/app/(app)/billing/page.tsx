import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/nexora/module-placeholder";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { getNavItem } from "@/config/navigation";

const item = getNavItem("billing");

export const metadata: Metadata = { title: "Billing" };

export default function BillingPage() {
  return (
    <ProtectedPage permission="billing.view" title={item.label}>
      <PageContainer>
        <PageIntro description={item.description} />
        <ModulePlaceholder item={item} />
      </PageContainer>
    </ProtectedPage>
  );
}
