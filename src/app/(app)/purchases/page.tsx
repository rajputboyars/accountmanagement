import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/nexora/module-placeholder";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { getNavItem } from "@/config/navigation";

const item = getNavItem("purchases");

export const metadata: Metadata = { title: "Purchases" };

export default function PurchasesPage() {
  return (
    <PageContainer>
      <PageIntro description={item.description} />
      <ModulePlaceholder item={item} />
    </PageContainer>
  );
}
