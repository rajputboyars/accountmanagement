import type { Metadata } from "next";
import Link from "next/link";
import { History, Undo2 } from "lucide-react";
import { BillingScreen } from "@/components/sales/billing-screen";
import { AccessDenied } from "@/components/nexora/access-denied";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { buttonVariants } from "@/components/ui/button";
import { getNavItem } from "@/config/navigation";
import { CATALOG_MANAGE, shopHasProducts } from "@/modules/catalog";
import { hasPermission } from "@/modules/identity";
import { BILLING_CREATE, listBillingCustomers } from "@/modules/sales";
import { homePathForRole, requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";

const item = getNavItem("billing");

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.billing") };
}

export default function BillingPage() {
  return (
    <ProtectedPage permission="billing.view" title={item.label} guide="billing">
      <NewBill />
    </ProtectedPage>
  );
}

async function NewBill() {
  const session = await requireSession();
  if (!(await hasPermission(session, BILLING_CREATE))) {
    return (
      <PageContainer>
        <AccessDenied title="New bill" homeHref={homePathForRole(session.role)} />
      </PageContainer>
    );
  }
  const t = await getT();
  const [customers, hasProducts, canAddProducts] = await Promise.all([listBillingCustomers(session), shopHasProducts(session.shopId), hasPermission(session, CATALOG_MANAGE)]);
  return (
    <PageContainer>
      <PageIntro
        description={t("billing.intro")}
        actions={
          <>
            <Link href="/billing/returns" className={buttonVariants({ variant: "outline", size: "touch" })}>
              <Undo2 aria-hidden="true" />
              {t("billing.returns")}
            </Link>
            <Link href="/billing/invoices" className={buttonVariants({ variant: "outline", size: "touch" })}>
              <History aria-hidden="true" />
              {t("billing.bills")}
            </Link>
          </>
        }
      />
      <BillingScreen customers={customers} firstRun={{ noProducts: !hasProducts, canAddProducts }} />
    </PageContainer>
  );
}
