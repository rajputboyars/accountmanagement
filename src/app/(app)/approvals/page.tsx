import type { Metadata } from "next";
import { Clock, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getNavItem } from "@/config/navigation";
import { listShopProductsForStock } from "@/modules/catalog";
import { APPROVAL_ACTION_LABELS, hasPermission, listApprovals, REQUESTABLE_ACTIONS, type SessionContext } from "@/modules/identity";
import { listBillingCustomers, listInvoices } from "@/modules/sales";
import { indiaDate } from "@/shared/financial-year";
import { checkPagePermission } from "@/server/auth";
import { ApprovalCard, NewApprovalForm, type RequestOptions } from "./approval-cards";

const item = getNavItem("approvals");

export const metadata: Metadata = { title: "Approvals" };

export default function ApprovalsPage() {
  return (
    <ProtectedPage title="Approvals">
      <ApprovalsContent />
    </ProtectedPage>
  );
}

/** What this person may ask for (they must be allowed to do the action itself) and the records to pick from. */
async function requestOptions(session: SessionContext): Promise<RequestOptions | null> {
  if (session.role === "owner") return null;
  const [canBill, canAdjust, canCorrect] = await Promise.all([hasPermission(session, "billing.create"), hasPermission(session, "stock.adjust"), hasPermission(session, "invoice.edit")]);
  const allowed = REQUESTABLE_ACTIONS.filter((action) => (action === "stock_adjustment" ? canAdjust : action === "edit_invoice" ? canCorrect : canBill));
  if (allowed.length === 0) return null;
  const [customers, products, invoices] = await Promise.all([
    canBill ? listBillingCustomers(session) : [],
    canAdjust ? listShopProductsForStock(session.shopId) : [],
    canCorrect ? listInvoices(session, { date: indiaDate() }).then((result) => result.items.filter((invoice) => invoice.status === "issued")) : [],
  ]);
  return {
    actions: allowed.map((action) => ({ action, label: APPROVAL_ACTION_LABELS[action] })),
    customers: customers.map((customer) => ({ id: customer.id, name: customer.name })),
    products: products.filter((product) => product.isActive).map((product) => ({ id: product.id, name: product.name })),
    invoices: invoices.map((invoice) => ({ number: invoice.number, label: `${invoice.number} · ${invoice.customerName}` })),
  };
}

async function ApprovalsContent() {
  const { session, allowed } = await checkPagePermission("approvals.view");
  const [approvals, options] = allowed ? await Promise.all([listApprovals(session, { status: "all" }), requestOptions(session)]) : [[], null];

  const pending = approvals.filter((a) => a.status === "pending");
  const resolved = approvals.filter((a) => a.status !== "pending");
  const isOwner = session.role === "owner";

  return (
    <PageContainer>
      <PageIntro description={item.description} />

      {options ? <NewApprovalForm options={options} /> : null}

      <SectionCard
        title="Pending approvals inbox"
        description={
          isOwner
            ? "Requests from staff. Approve or reject; you can't decide your own. Approvals last 10 minutes and are used once."
            : "Your requests. Once approved, save the bill, adjustment or correction again within 10 minutes."
        }
        action={
          pending.length > 0 ? (
            <Badge variant="warning" className="gap-1 px-2.5">
              <Clock className="size-3.5" aria-hidden="true" />
              {pending.length} pending
            </Badge>
          ) : (
            <Badge variant="success" className="gap-1 px-2.5">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              All clear
            </Badge>
          )
        }
      >
        {pending.length > 0 ? (
          <div className="flex flex-col gap-3">
            {pending.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <ShieldCheck className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-sm font-medium text-foreground">No pending approval requests</p>
            <p className="text-xs text-muted-foreground">
              When high-risk actions like large stock adjustments or exceptional discounts are requested, they appear here.
            </p>
          </div>
        )}
      </SectionCard>

      {resolved.length > 0 ? (
        <SectionCard
          title="Past approvals & decisions"
          description="Recent approved, rejected, used, or expired requests."
        >
          <div className="flex flex-col gap-3">
            {resolved.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} />
            ))}
          </div>
        </SectionCard>
      ) : null}
    </PageContainer>
  );
}
