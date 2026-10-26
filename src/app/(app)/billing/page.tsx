import type { Metadata } from "next";
import Link from "next/link";
import { History } from "lucide-react";
import { BillingScreen } from "@/components/sales/billing-screen";
import { AccessDenied } from "@/components/nexora/access-denied";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { buttonVariants } from "@/components/ui/button";
import { getNavItem } from "@/config/navigation";
import { hasPermission } from "@/modules/identity";
import { BILLING_CREATE, listBillingCustomers } from "@/modules/sales";
import { homePathForRole, requireSession } from "@/server/auth";

const item = getNavItem("billing");

export const metadata: Metadata = { title: "Billing" };

export default function BillingPage() {
  return (
    <ProtectedPage permission="billing.view" title={item.label}>
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
  const customers = await listBillingCustomers(session);
  return (
    <PageContainer>
      <PageIntro
        description="Add items, choose the customer and take payment. Every rate, tax and total is worked out on the server from your saved prices."
        actions={
          <Link href="/billing/invoices" className={buttonVariants({ variant: "outline", size: "touch" })}>
            <History aria-hidden="true" />
            Bills
          </Link>
        }
      />
      <BillingScreen customers={customers} />
    </PageContainer>
  );
}
