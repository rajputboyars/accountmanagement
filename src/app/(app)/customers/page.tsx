import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/nexora/module-placeholder";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { getNavItem } from "@/config/navigation";

const item = getNavItem("customers");

export const metadata: Metadata = { title: "Customers" };

export default function CustomersPage() {
  return (
    <PageContainer>
      <PageIntro description={item.description} />
      <ModulePlaceholder item={item} />
    </PageContainer>
  );
}
