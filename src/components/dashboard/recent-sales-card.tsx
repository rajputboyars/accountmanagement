import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/nexora/money";
import { SectionCard } from "@/components/nexora/section-card";
import type { DemoSale } from "@/demo/dashboard-data";

export function RecentSalesCard({ sales }: { sales: readonly DemoSale[] }) {
  return (
    <SectionCard title="Recent sales" description="Today's bills, newest first" className="xl:col-span-2" flush>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">Bill</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Payment</TableHead>
            <TableHead className="pr-5 text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sales.map((sale) => (
            <TableRow key={sale.invoiceNumber}>
              <TableCell className="pl-5">
                <div className="flex flex-col">
                  <span className="font-medium text-foreground tabular-nums">{sale.invoiceNumber}</span>
                  <span className="text-xs text-muted-foreground">{sale.time}</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <span className="text-foreground">{sale.customer}</span>
                  <Badge variant={sale.priceList === "wholesale" ? "info" : "neutral"}>
                    {sale.priceList === "wholesale" ? "Wholesale" : "Retail"}
                  </Badge>
                </div>
              </TableCell>
              <TableCell>
                {sale.paidNowPaise === sale.totalPaise ? (
                  <Badge variant="success">Paid · {sale.method}</Badge>
                ) : sale.paidNowPaise === 0 ? (
                  <Badge variant="warning">On credit</Badge>
                ) : (
                  <Badge variant="warning">Part paid</Badge>
                )}
              </TableCell>
              <TableCell className="pr-5 text-right font-semibold text-foreground">
                <Money paise={sale.totalPaise} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}
