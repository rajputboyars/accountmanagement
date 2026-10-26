import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/nexora/module-placeholder";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { getNavItem } from "@/config/navigation";

const item = getNavItem("purchases");

export const metadata: Metadata = { title: "Purchases" };

export default function PurchasesPage() {
  return (
    <ProtectedPage permission="purchases.view" title={item.label}>
      <PageContainer>
        <PageIntro description={item.description} />
        <ModulePlaceholder item={item} />
      </PageContainer>
    </ProtectedPage>
  );
}
