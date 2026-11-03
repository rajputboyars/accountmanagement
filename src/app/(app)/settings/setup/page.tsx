import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CircleCheck, CircleDashed, Download, FileSpreadsheet } from "lucide-react";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { IMPORT_LIMITS, EXPORT_TYPES, getOnboardingStatus, IMPORT_TYPES, listImports } from "@/modules/imports";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { translateServerMessage } from "@/shared/i18n";
import { timeLabel } from "@/shared/i18n/labels";
import { UploadForm } from "./import-forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("golive.title") };
}

type Props = PageProps<"/settings/setup">;

export default function SetupPage({ searchParams }: Props) {
  return (
    <ProtectedPage permission="import.run" title="go-live setup">
      <SetupContent searchParams={searchParams} />
    </ProtectedPage>
  );
}

const STATUS = {
  previewed: { label: "golive.status.previewed", variant: "warning" },
  committing: { label: "golive.status.committing", variant: "warning" },
  committed: { label: "golive.status.committed", variant: "success" },
  failed: { label: "golive.status.failed", variant: "danger" },
  uploaded: { label: "golive.status.uploaded", variant: "neutral" },
} as const;
const statusOf = (status: string) => (Object.hasOwn(STATUS, status) ? STATUS[status as keyof typeof STATUS] : null);

async function SetupContent({ searchParams }: Pick<Props, "searchParams">) {
  const [query, session] = await Promise.all([searchParams, requireSession()]);
  const [status, history] = await Promise.all([getOnboardingStatus(session), listImports(session)]);
  const chosen = typeof query.type === "string" && (IMPORT_TYPES as readonly string[]).includes(query.type) ? query.type : undefined;
  const percent = Math.round((status.done / status.total) * 100);
  const [t, language] = await Promise.all([getT(), getLanguage()]);

  return (
    <PageContainer className="max-w-6xl">
      <Link href="/settings" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("nav.settings.label")}
      </Link>
      <PageIntro description={t("golive.intro")} />

      <section aria-label={t("golive.progressLabel")} className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm text-panel-muted">{t("golive.progress")}</p>
            <p className="text-3xl font-bold tabular-nums">
              {t("golive.doneCount", { done: status.done, total: status.total })}
            </p>
          </div>
          {status.complete ? <Badge variant="success">{t("golive.ready")}</Badge> : null}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-panel-foreground/15" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={t("golive.progressLabel")}>
          <div className="h-full rounded-full bg-teal" style={{ width: `${percent}%` }} />
        </div>
      </section>

      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {status.steps.map((step, index) => (
          <li key={step.key} className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              {step.done ? <CircleCheck className="size-5 shrink-0 text-success" aria-hidden="true" /> : <CircleDashed className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
              <span className="font-semibold text-foreground">
                {index + 1}. {translateServerMessage(step.title, language)}
              </span>
              <span className="sr-only">{t(step.done ? "golive.stepDone" : "golive.stepToDo")}</span>
            </div>
            <p className="text-sm text-muted-foreground">{translateServerMessage(step.detail, language)}</p>
            <div className="mt-auto flex flex-wrap gap-3 text-sm font-semibold">
              <Link href={step.href} className="inline-flex min-h-10 items-center text-teal-strong hover:underline">
                {t(step.done ? "golive.open" : "golive.doIt")}
              </Link>
              {step.importType ? (
                <Link href={`/settings/setup?type=${step.importType}#import`} className="inline-flex min-h-10 items-center text-muted-foreground hover:text-foreground">
                  {t("golive.importCsv")}
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      <SectionCard title={t("golive.importTitle")} description={t("golive.importHelp")}>
        <div id="import" className="flex flex-col gap-5">
          <UploadForm types={IMPORT_TYPES.map((type) => ({ value: type, label: t(`import.type.${type}`) }))} defaultType={chosen} maxBytes={IMPORT_LIMITS.maxBytes} />
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <span className="inline-flex min-h-10 items-center font-medium text-foreground">{t("golive.templates")}</span>
            {IMPORT_TYPES.map((type) => (
              <a key={type} href={`/settings/setup/template/${type}`} download className="inline-flex min-h-10 items-center gap-1 text-teal-strong hover:underline">
                <FileSpreadsheet className="size-3.5" aria-hidden="true" />
                {t(`import.type.${type}`)}
              </a>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <span className="inline-flex min-h-10 items-center font-medium text-foreground">{t("golive.exportData")}</span>
            {EXPORT_TYPES.map((type) => (
              <a key={type} href={`/settings/setup/export/${type}`} download className="inline-flex min-h-10 items-center gap-1 text-muted-foreground hover:text-foreground">
                <Download className="size-3.5" aria-hidden="true" />
                {t(`import.type.${type}`)}
              </a>
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard title={t("golive.history")} flush>
        {history.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">{t("golive.noImports")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border pb-2">
            {history.map((job) => (
              <li key={job.id}>
                <Link href={`/settings/setup/imports/${job.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-muted/50">
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{t(`import.type.${job.type}`)}</span> · {job.fileName ?? "CSV"}
                    <span className="block text-xs text-muted-foreground">
                      {timeLabel(job.createdAt, language)} · {job.createdByName} · {t("golive.historyLine", { total: job.total, created: job.created, skipped: job.skipped, errors: job.errors })}
                    </span>
                  </span>
                  <Badge variant={statusOf(job.status)?.variant ?? "neutral"}>{statusOf(job.status) ? t(statusOf(job.status)!.label) : job.status}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </PageContainer>
  );
}
