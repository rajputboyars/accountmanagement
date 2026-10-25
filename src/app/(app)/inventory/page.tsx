import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/nexora/module-placeholder";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { getNavItem } from "@/config/navigation";

const item = getNavItem("inventory");

export const metadata: Metadata = { title: "Products & Inventory" };

export default function InventoryPage() {
  return (
    <PageContainer>
      <PageIntro description={item.description} />
      <ModulePlaceholder item={item} />
    </PageContainer>
  );
}
