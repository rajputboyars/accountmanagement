"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Check, CircleAlert, CircleCheck, Clock, LoaderCircle, ShieldAlert, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ApprovalView, RequestableAction } from "@/modules/identity";
import { formatPaise } from "@/shared/money";
import { decideApprovalAction, requestApprovalAction, type FormState } from "./actions";

const fieldClass = "flex flex-col gap-2 text-sm font-medium text-foreground";

function SubmitButton({
  children,
  variant = "default",
  className = "",
}: {
  children: React.ReactNode;
  variant?: "default" | "outline" | "destructive";
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="touch" variant={variant} disabled={pending} className={className}>
      {pending ? <LoaderCircle className="animate-spin size-3.5" aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}

function FormFeedback({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p role="alert" className="flex items-center gap-2 text-xs text-danger">
        <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-success">
        <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />
        {state.message}
      </p>
    );
  }
  return null;
}

const STATUS_LABELS: Record<ApprovalView["status"], string> = { pending: "Waiting", approved: "Approved", rejected: "Rejected", used: "Used", expired: "Expired" };

const STATUS_VARIANTS: Record<ApprovalView["status"], "warning" | "success" | "danger" | "neutral"> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  used: "neutral",
  expired: "neutral",
};

export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [state, formAction] = useActionState(decideApprovalAction, {});

  const now = new Date();
  const expiresAt = new Date(approval.expiresAt);
  const minutesLeft = Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / (60 * 1000)));

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="info">{approval.actionLabel}</Badge>
          <span className="font-semibold text-foreground">{approval.targetLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          {approval.status === "pending" ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3.5" aria-hidden="true" />
              {minutesLeft > 0 ? `${minutesLeft}m left` : "Expiring"}
            </span>
          ) : null}
          <Badge variant={STATUS_VARIANTS[approval.status]}>
            {STATUS_LABELS[approval.status]}
          </Badge>
        </div>
      </div>

      <div className="grid gap-2 text-sm text-foreground sm:grid-cols-2">
        <div>
          <span className="text-xs text-muted-foreground">Requested by: </span>
          <span className="font-medium">{approval.requesterName}</span>
          <span className="ml-1 text-xs text-muted-foreground">({approval.requesterRole})</span>
        </div>
        {approval.amountPaise !== null ? (
          <div>
            <span className="text-xs text-muted-foreground">{approval.action === "credit_over_limit" ? "Highest dues: " : "Value at cost up to: "}</span>
            <span className="font-semibold tabular-nums text-foreground">
              {formatPaise(approval.amountPaise, { withPaise: false })}
            </span>
          </div>
        ) : null}
        {approval.limitBp !== null ? (
          <div>
            <span className="text-xs text-muted-foreground">Discount up to: </span>
            <span className="font-semibold tabular-nums text-foreground">{(approval.limitBp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%</span>
          </div>
        ) : null}
        {approval.quantity ? (
          <div>
            <span className="text-xs text-muted-foreground">Quantity: </span>
            <span className="font-semibold tabular-nums text-foreground">
              {approval.quantity} {approval.unit ?? ""}
            </span>
          </div>
        ) : null}
        <div className="sm:col-span-2">
          <span className="text-xs text-muted-foreground">Reason: </span>
          <span className="italic text-foreground">&ldquo;{approval.reason}&rdquo;</span>
        </div>
      </div>

      {approval.decisionReason || approval.decisionByName ? (
        <div className="rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {approval.status === "approved" ? "Approved by" : "Reviewed by"}: {approval.decisionByName ?? "Owner"}
          </span>
          {approval.decisionReason ? (
            <p className="mt-0.5 text-foreground italic">&ldquo;{approval.decisionReason}&rdquo;</p>
          ) : null}
        </div>
      ) : null}

      {approval.canDecide && approval.status === "pending" ? (
        <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
          {!showRejectForm ? (
            <div className="flex items-center gap-2">
              <form action={formAction} className="inline-flex items-center gap-2">
                <input type="hidden" name="approvalId" value={approval.id} />
                <input type="hidden" name="decision" value="approve" />
                <Input
                  name="reason"
                  placeholder="Note (optional)"
                  className="h-10 max-w-[200px] text-sm"
                />
                <SubmitButton className="gap-1 bg-success hover:bg-success/90 text-white">
                  <Check className="size-3.5" aria-hidden="true" />
                  Approve
                </SubmitButton>
              </form>
              <Button
                type="button"
                size="touch"
                variant="outline"
                onClick={() => setShowRejectForm(true)}
                className="gap-1 text-danger hover:bg-danger-soft hover:text-danger"
              >
                <X className="size-3.5" aria-hidden="true" />
                Reject
              </Button>
            </div>
          ) : (
            <form action={formAction} className="flex flex-col gap-2">
              <input type="hidden" name="approvalId" value={approval.id} />
              <input type="hidden" name="decision" value="reject" />
              <label className="text-xs font-medium text-foreground">
                Rejection reason (required)
                <Input
                  name="reason"
                  required
                  minLength={3}
                  placeholder="Why is this rejected? (e.g. discount exceeds policy)"
                  className="mt-1 h-10 text-sm"
                />
              </label>
              <div className="flex items-center gap-2">
                <SubmitButton variant="destructive" className="gap-1">
                  Confirm Rejection
                </SubmitButton>
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  onClick={() => setShowRejectForm(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
          <FormFeedback state={state} />
        </div>
      ) : null}
    </div>
  );
}

export type RequestOptions = {
  actions: { action: RequestableAction; label: string }[];
  customers: { id: string; name: string }[];
  products: { id: string; name: string }[];
  invoices: { number: string; label: string }[];
};

const selectClass = "h-11 rounded-lg border border-input bg-background px-3 text-sm text-foreground";

/** Ask the owner. Pick what for and which record; the owner sees the record's real name. */
export function NewApprovalForm({ options }: { options: RequestOptions }) {
  const [state, formAction] = useActionState(requestApprovalAction, {});
  const [action, setAction] = useState<RequestableAction>(options.actions[0]!.action);

  return (
    <form action={formAction} className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber" aria-hidden="true" />
        <div>
          <h2 className="font-semibold text-foreground">Ask the owner</h2>
          <p className="text-sm text-muted-foreground">Once approved, save the bill, adjustment or correction again within 10 minutes. The approval is used once.</p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className={fieldClass}>
          What needs approval
          <select name="action" value={action} onChange={(event) => setAction(event.target.value as RequestableAction)} className={selectClass}>
            {options.actions.map((option) => (
              <option key={option.action} value={option.action}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldClass}>
          {action === "stock_adjustment" ? "Product" : action === "edit_invoice" ? "Bill (today)" : "Customer"}
          <select key={action} name="targetRef" required className={selectClass} defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {action === "discount_over_limit" ? <option value="any">Any customer / walk-in</option> : null}
            {action === "stock_adjustment"
              ? options.products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))
              : action === "edit_invoice"
                ? options.invoices.map((invoice) => (
                    <option key={invoice.number} value={invoice.number}>
                      {invoice.label}
                    </option>
                  ))
                : options.customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
          </select>
        </label>
        {action === "discount_over_limit" ? (
          <label className={fieldClass}>
            Discount needed (%)
            <Input name="discountPercent" inputMode="decimal" required placeholder="10" className="h-11" />
          </label>
        ) : null}
        {action === "credit_over_limit" ? (
          <label className={fieldClass}>
            Highest dues after the bill (₹)
            <Input name="amount" inputMode="decimal" required placeholder="1,20,000" className="h-11" />
          </label>
        ) : null}
        {action === "stock_adjustment" ? (
          <>
            <label className={fieldClass}>
              Value at cost, up to (₹)
              <Input name="amount" inputMode="decimal" placeholder="Leave empty if no cost price" className="h-11" />
            </label>
            <label className={fieldClass}>
              Quantity (for the owner)
              <Input name="quantity" placeholder="e.g. 12 pc damaged" className="h-11" />
            </label>
          </>
        ) : null}
        <label className={`${fieldClass} sm:col-span-2 lg:col-span-4`}>
          Reason
          <Input name="reason" required minLength={3} maxLength={300} placeholder="Why is this needed?" className="h-11" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton className="h-11 px-4">Send to owner</SubmitButton>
        <FormFeedback state={state} />
      </div>
    </form>
  );
}
