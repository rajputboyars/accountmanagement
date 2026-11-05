import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ImportForm, type SavedMapping } from "@/components/bank/import-form";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getBankAccount } from "@/modules/accounting";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getT } from "@/server/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("bank.import.title") };
}

type Props = { params: Promise<{ accountId: string }> };

export default function ImportPage({ params }: Props) {
  return (
    <ProtectedPage permission="settings.edit" title="Import statement">
      <ImportView params={params} />
    </ProtectedPage>
  );
}

async function ImportView({ params }: Props) {
  const { accountId } = await params;
  const session = await requireSession();
  const t = await getT();
  const account = await getBankAccount(session, accountId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!account) return null;
  return (
    <PageContainer className="max-w-3xl">
      <Link href={`/reports/money/bank/${account.id}`} className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {account.name}
      </Link>
      <PageIntro description={t("bank.import.intro")} />
      <SectionCard title={t("bank.import.title")}>
        <ImportForm bankAccountId={account.id} saved={account.csvMapping as SavedMapping} />
      </SectionCard>
    </PageContainer>
  );
}
