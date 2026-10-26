import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CircleCheck, CircleDashed, Download, FileSpreadsheet } from "lucide-react";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { EXPORT_TYPES, getOnboardingStatus, IMPORT_TYPE_LABELS, IMPORT_TYPES, listImports } from "@/modules/imports";
import { requireSession } from "@/server/auth";
import { UploadForm } from "./import-forms";

export const metadata: Metadata = { title: "Go-live setup" };

type Props = PageProps<"/settings/setup">;

export default function SetupPage({ searchParams }: Props) {
  return (
    <ProtectedPage permission="import.run" title="go-live setup">
      <SetupContent searchParams={searchParams} />
    </ProtectedPage>
  );
}

const STATUS: Record<string, { label: string; variant: "success" | "warning" | "danger" | "neutral" }> = {
  previewed: { label: "Waiting for review", variant: "warning" },
  committing: { label: "Saving", variant: "warning" },
  committed: { label: "Imported", variant: "success" },
  failed: { label: "Not finished", variant: "danger" },
  uploaded: { label: "Uploaded", variant: "neutral" },
};
const timeText = (date: Date) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(date);

async function SetupContent({ searchParams }: Pick<Props, "searchParams">) {
  const [query, session] = await Promise.all([searchParams, requireSession()]);
  const [status, history] = await Promise.all([getOnboardingStatus(session), listImports(session)]);
  const chosen = typeof query.type === "string" && (IMPORT_TYPES as readonly string[]).includes(query.type) ? query.type : undefined;
  const percent = Math.round((status.done / status.total) * 100);

  return (
    <PageContainer className="max-w-6xl">
      <Link href="/settings" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Settings
      </Link>
      <PageIntro description="Get the shop ready: details, staff, products, opening stock, customers with old dues, suppliers." />

      <section aria-label="Setup progress" className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm text-panel-muted">Go-live progress</p>
            <p className="text-3xl font-bold tabular-nums">
              {status.done} of {status.total} done
            </p>
          </div>
          {status.complete ? <Badge variant="success">Ready to go live</Badge> : null}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-panel-foreground/15" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
          <div className="h-full rounded-full bg-teal" style={{ width: `${percent}%` }} />
        </div>
      </section>

      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {status.steps.map((step, index) => (
          <li key={step.key} className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              {step.done ? <CircleCheck className="size-5 shrink-0 text-success" aria-hidden="true" /> : <CircleDashed className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
              <span className="font-semibold text-foreground">
                {index + 1}. {step.title}
              </span>
              <span className="sr-only">{step.done ? "done" : "to do"}</span>
            </div>
            <p className="text-sm text-muted-foreground">{step.detail}</p>
            <div className="mt-auto flex flex-wrap gap-3 text-sm font-semibold">
              <Link href={step.href} className="inline-flex min-h-10 items-center text-teal-strong hover:underline">
                {step.done ? "Open" : "Do it"}
              </Link>
              {step.importType ? (
                <Link href={`/settings/setup?type=${step.importType}#import`} className="inline-flex min-h-10 items-center text-muted-foreground hover:text-foreground">
                  Import CSV
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      <SectionCard title="Import from a spreadsheet" description="Download a template, fill it in Excel or Google Sheets, save as CSV and upload. Every row is checked before anything is saved.">
        <div id="import" className="flex flex-col gap-5">
          <UploadForm types={IMPORT_TYPES.map((type) => ({ value: type, label: IMPORT_TYPE_LABELS[type] }))} defaultType={chosen} />
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <span className="inline-flex min-h-10 items-center font-medium text-foreground">Templates:</span>
            {IMPORT_TYPES.map((type) => (
              <a key={type} href={`/settings/setup/template/${type}`} download className="inline-flex min-h-10 items-center gap-1 text-teal-strong hover:underline">
                <FileSpreadsheet className="size-3.5" aria-hidden="true" />
                {IMPORT_TYPE_LABELS[type]}
              </a>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <span className="inline-flex min-h-10 items-center font-medium text-foreground">Export current data:</span>
            {EXPORT_TYPES.map((type) => (
              <a key={type} href={`/settings/setup/export/${type}`} download className="inline-flex min-h-10 items-center gap-1 text-muted-foreground hover:text-foreground">
                <Download className="size-3.5" aria-hidden="true" />
                {IMPORT_TYPE_LABELS[type]}
              </a>
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Import history" flush>
        {history.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">No imports yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border pb-2">
            {history.map((job) => (
              <li key={job.id}>
                <Link href={`/settings/setup/imports/${job.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-muted/50">
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{job.typeLabel}</span> · {job.fileName ?? "CSV"}
                    <span className="block text-xs text-muted-foreground">
                      {timeText(job.createdAt)} · {job.createdByName} · {job.total} rows · {job.created} saved · {job.skipped} skipped · {job.errors} errors
                    </span>
                  </span>
                  <Badge variant={STATUS[job.status]?.variant ?? "neutral"}>{STATUS[job.status]?.label ?? job.status}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </PageContainer>
  );
}
