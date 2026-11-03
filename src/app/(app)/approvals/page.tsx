import type { Metadata } from "next";
import { Clock, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { listShopProductsForStock } from "@/modules/catalog";
import { hasPermission, listApprovals, REQUESTABLE_ACTIONS, type ApprovalView, type SessionContext } from "@/modules/identity";
import { listBillingCustomers, listInvoices } from "@/modules/sales";
import { indiaDate } from "@/shared/financial-year";
import { checkPagePermission } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { systemName } from "@/shared/i18n/labels";
import type { Language, Translate } from "@/shared/i18n";
import { ApprovalCard, NewApprovalForm, type RequestOptions } from "./approval-cards";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("nav.approvals.label") };
}

export default function ApprovalsPage() {
  return (
    <ProtectedPage title="Approvals" guide="approvals">
      <ApprovalsContent />
    </ProtectedPage>
  );
}

/** What this person may ask for (they must be allowed to do the action itself) and the records to pick from. */
async function requestOptions(session: SessionContext, t: Translate): Promise<RequestOptions | null> {
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
    actions: allowed.map((action) => ({ action, label: t(`approvals.action.${action}`) })),
    customers: customers.map((customer) => ({ id: customer.id, name: customer.name })),
    products: products.filter((product) => product.isActive).map((product) => ({ id: product.id, name: product.name })),
    invoices: invoices.map((invoice) => ({ number: invoice.number, label: `${invoice.number} · ${invoice.customerName}` })),
  };
}

/** Words for the screen only: what somebody typed and the saved request stay as they are. */
function forDisplay(approval: ApprovalView, t: Translate, language: Language): ApprovalView {
  return { ...approval, actionLabel: t(`approvals.action.${approval.action}`), targetLabel: systemName(approval.targetLabel, language) };
}

async function ApprovalsContent() {
  const { session, allowed } = await checkPagePermission("approvals.view");
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const [saved, options] = allowed ? await Promise.all([listApprovals(session, { status: "all" }), requestOptions(session, t)]) : [[], null];
  const approvals = saved.map((approval) => forDisplay(approval, t, language));

  const pending = approvals.filter((a) => a.status === "pending");
  const resolved = approvals.filter((a) => a.status !== "pending");
  const isOwner = session.role === "owner";

  return (
    <PageContainer>
      <PageIntro description={t("nav.approvals.description")} />

      {options ? <NewApprovalForm options={options} /> : null}

      <SectionCard
        title={t("approvals.inbox")}
        description={
          isOwner
            ? t("approvals.inboxOwner")
            : t("approvals.inboxStaff")
        }
        action={
          pending.length > 0 ? (
            <Badge variant="warning" className="gap-1 px-2.5">
              <Clock className="size-3.5" aria-hidden="true" />
              {t("approvals.pendingCount", { count: pending.length })}
            </Badge>
          ) : (
            <Badge variant="success" className="gap-1 px-2.5">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              {t("approvals.allClear")}
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
            <p className="mt-2 text-sm font-medium text-foreground">{t("approvals.none")}</p>
            <p className="text-xs text-muted-foreground">
              {t("approvals.noneHint")}
            </p>
          </div>
        )}
      </SectionCard>

      {resolved.length > 0 ? (
        <SectionCard
          title={t("approvals.past")}
          description={t("approvals.pastDescription")}
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
