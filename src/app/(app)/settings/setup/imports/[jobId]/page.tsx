import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { getImport } from "@/modules/imports";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getLanguage, getT } from "@/server/i18n";
import { translateServerMessage } from "@/shared/i18n";
import { importProblemLabel } from "@/shared/i18n/labels";
import { CommitForm, MappingForm } from "../../import-forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("golive.importCsv") };
}

type Props = PageProps<"/settings/setup/imports/[jobId]">;

export default function ImportPage({ params }: Props) {
  return (
    <ProtectedPage permission="import.run" title="this import">
      <ImportView params={params} />
    </ProtectedPage>
  );
}

async function ImportView({ params }: Pick<Props, "params">) {
  const { jobId } = await params;
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const job = await getImport(await requireSession(), jobId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!job) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t("import.notFound")} description={t("import.otherShop")}>
          <Link href="/settings/setup" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("import.backToSetup")}
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }
  const editable = job.status === "previewed" || job.status === "failed";
  const shownColumns = job.headers.slice(0, 6);
  const { summary } = job;
  return (
    <PageContainer className="max-w-6xl">
      <Link href="/settings/setup" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("golive.title")}
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t("import.heading", { type: t(`import.type.${job.type}`), file: job.fileName ?? "CSV" })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(editable ? "import.summaryReady" : "import.summarySaved", { total: summary.total, ready: summary.ready, created: summary.created, skipped: summary.skipped, errors: summary.errors })}
          {summary.note ? ` · ${translateServerMessage(summary.note, language)}` : ""}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {editable ? (
          <SectionCard title={t("import.columns")} description={t("import.columnsHelp")}>
            <MappingForm jobId={job.id} headers={job.headers} fields={job.fields.map((field) => ({ ...field, label: translateServerMessage(field.label, language) }))} mapping={job.mapping} />
          </SectionCard>
        ) : null}
        <SectionCard title={t(editable ? "import.save" : "import.result")} className={editable ? undefined : "lg:col-span-2"}>
          <div className="flex flex-col gap-3 text-sm">
            {editable ? (
              summary.ready > 0 ? (
                <>
                  <p className="text-muted-foreground">{t("import.leftOutNote")}</p>
                  <CommitForm jobId={job.id} ready={summary.ready} />
                </>
              ) : (
                <p className="text-muted-foreground">{t("import.noneReady")}</p>
              )
            ) : (
              <p className="flex flex-wrap items-center gap-2 text-foreground">
                <Badge variant={job.status === "committed" ? "success" : "warning"}>{t(job.status === "committed" ? "golive.status.committed" : "golive.status.committing")}</Badge>
                {t("import.resultLine", { created: summary.created, skipped: summary.skipped, errors: summary.errors })}
              </p>
            )}
            {summary.skipped + summary.errors > 0 ? (
              <a href={`/settings/setup/imports/${job.id}/problems`} download className="inline-flex min-h-10 items-center gap-1 font-semibold text-teal-strong hover:underline">
                <Download className="size-3.5" aria-hidden="true" />
                {t("import.downloadLeftOut")}
              </a>
            ) : null}
          </div>
        </SectionCard>
      </div>

      <SectionCard title={t("import.rowsTitle")} description={summary.total > job.rows.length ? t("import.firstRows", { shown: job.rows.length, total: summary.total }) : undefined} flush>
        <div className="overflow-x-auto">
          <table className="stack-table stack-table-flush w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 pl-5 font-medium">
                  {t("import.row")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("common.status")}
                </th>
                {shownColumns.map((header, index) => (
                  <th key={index} scope="col" className="px-3 py-2 font-medium">
                    {header}
                  </th>
                ))}
                <th scope="col" className="py-2 pr-5 pl-3 font-medium">
                  {t("import.problem")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {job.rows.map((row) => (
                <tr key={row.rowNo} className={row.result === null ? "bg-danger-soft/40" : undefined}>
                  <td data-title data-label={t("import.row")} className="py-2 pr-3 pl-5 text-muted-foreground tabular-nums">{row.rowNo}</td>
                  <td data-key className="px-3 py-2">{row.saved ? <Badge variant="success">{t("import.rowSaved")}</Badge> : row.result === "new" ? <Badge variant="info">{t("import.rowReady")}</Badge> : row.result === "skip" ? <Badge variant="neutral">{t("import.rowSkipped")}</Badge> : <Badge variant="danger">{t("import.rowError")}</Badge>}</td>
                  {shownColumns.map((header, index) => (
                    <td key={index} data-label={header} className="max-w-48 truncate px-3 py-2">
                      {row.cells[index] ?? ""}
                    </td>
                  ))}
                  <td data-label={t("import.problem")} className="py-2 pr-5 pl-3 text-xs text-muted-foreground">{row.error ? importProblemLabel(row.error, language) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </PageContainer>
  );
}
