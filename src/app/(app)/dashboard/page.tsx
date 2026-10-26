import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { DashboardKpis } from "@/components/dashboard/dashboard-kpis";
import { LowStockCard } from "@/components/dashboard/low-stock-card";
import { RecentPaymentsCard } from "@/components/dashboard/recent-payments-card";
import { RecentSalesCard } from "@/components/dashboard/recent-sales-card";
import { SalesTrendCard } from "@/components/dashboard/sales-trend-card";
import { buttonVariants } from "@/components/ui/button";
import { DemoDataNotice } from "@/components/nexora/demo-data-notice";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { getNavItem } from "@/config/navigation";
import { buildDashboardSummary } from "@/demo/dashboard-summary";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <ProtectedPage permission="reports.view" title="the owner dashboard">
      <DashboardContent />
    </ProtectedPage>
  );
}

function DashboardContent() {
  const summary = buildDashboardSummary();
  const item = getNavItem("dashboard");

  return (
    <PageContainer>
      <PageIntro
        description={`${summary.businessDate} · ${item.description}`}
        actions={
          <Link href="/billing" className={buttonVariants({ size: "touch" })}>
            <Plus aria-hidden="true" />
            New bill
          </Link>
        }
      />
      <DemoDataNotice />
      <DashboardKpis summary={summary} />
      <div className="grid gap-4 xl:grid-cols-3">
        <SalesTrendCard days={summary.trend} />
        <LowStockCard alerts={summary.stockAlerts} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <RecentSalesCard sales={summary.recentSales} />
        <RecentPaymentsCard payments={summary.recentPayments} />
      </div>
    </PageContainer>
  );
}
