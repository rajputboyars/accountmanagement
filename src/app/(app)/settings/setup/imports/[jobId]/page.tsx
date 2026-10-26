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
import { CommitForm, MappingForm } from "../../import-forms";

export const metadata: Metadata = { title: "Import" };

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
  const job = await getImport(await requireSession(), jobId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!job) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title="Import not found" description="It may belong to a different shop.">
          <Link href="/settings/setup" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to setup
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
        Go-live setup
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {job.typeLabel} import · {job.fileName ?? "CSV"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {summary.total} rows · {editable ? `${summary.ready} ready` : `${summary.created} saved`} · {summary.skipped} skipped (already there or repeated) · {summary.errors} with errors
          {summary.note ? ` · ${summary.note}` : ""}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {editable ? (
          <SectionCard title="Columns" description="Check which column of your file fills each field. * is required.">
            <MappingForm jobId={job.id} headers={job.headers} fields={job.fields} mapping={job.mapping} />
          </SectionCard>
        ) : null}
        <SectionCard title={editable ? "Save" : "Result"} className={editable ? undefined : "lg:col-span-2"}>
          <div className="flex flex-col gap-3 text-sm">
            {editable ? (
              summary.ready > 0 ? (
                <>
                  <p className="text-muted-foreground">Rows with errors or duplicates are left out. Each saved row is recorded as if entered by hand, with its audit entry.</p>
                  <CommitForm jobId={job.id} ready={summary.ready} />
                </>
              ) : (
                <p className="text-muted-foreground">No rows are ready. Fix the file or the columns and check again.</p>
              )
            ) : (
              <p className="flex flex-wrap items-center gap-2 text-foreground">
                <Badge variant={job.status === "committed" ? "success" : "warning"}>{job.status === "committed" ? "Imported" : "Saving"}</Badge>
                {summary.created} saved, {summary.skipped} skipped, {summary.errors} errors.
              </p>
            )}
            {summary.skipped + summary.errors > 0 ? (
              <a href={`/settings/setup/imports/${job.id}/problems`} download className="inline-flex min-h-10 items-center gap-1 font-semibold text-teal-strong hover:underline">
                <Download className="size-3.5" aria-hidden="true" />
                Download the rows that were left out
              </a>
            ) : null}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Rows" description={summary.total > job.rows.length ? `First ${job.rows.length} of ${summary.total} rows.` : undefined} flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 pl-5 font-medium">
                  Row
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                {shownColumns.map((header, index) => (
                  <th key={index} scope="col" className="px-3 py-2 font-medium">
                    {header}
                  </th>
                ))}
                <th scope="col" className="py-2 pr-5 pl-3 font-medium">
                  Problem
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {job.rows.map((row) => (
                <tr key={row.rowNo} className={row.result === null ? "bg-danger-soft/40" : undefined}>
                  <td className="py-2 pr-3 pl-5 text-muted-foreground tabular-nums">{row.rowNo}</td>
                  <td className="px-3 py-2">{row.saved ? <Badge variant="success">Saved</Badge> : row.result === "new" ? <Badge variant="info">Ready</Badge> : row.result === "skip" ? <Badge variant="neutral">Skipped</Badge> : <Badge variant="danger">Error</Badge>}</td>
                  {shownColumns.map((_, index) => (
                    <td key={index} className="max-w-48 truncate px-3 py-2">
                      {row.cells[index] ?? ""}
                    </td>
                  ))}
                  <td className="py-2 pr-5 pl-3 text-xs text-muted-foreground">{row.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </PageContainer>
  );
}
