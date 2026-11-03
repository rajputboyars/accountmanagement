import type { Metadata } from "next";
import { CircleCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { GuideStartButton } from "@/components/nexora/guide-start-button";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { loadPermissions, taskProgress } from "@/modules/identity";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";
import { GUIDED_TASKS, tasksFor, taskTitleKey } from "@/shared/guidance";
import type { MessageKey } from "@/shared/i18n/messages/en";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("guide.ui.pageTitle") };
}

export default function GuidesPage() {
  return (
    <ProtectedPage title="Guides">
      <Guides />
    </ProtectedPage>
  );
}

async function Guides() {
  const session = await requireSession();
  const [t, granted, progress] = await Promise.all([getT(), loadPermissions(session), taskProgress(session)]);
  const tasks = tasksFor(granted);
  return (
    <PageContainer className="max-w-3xl">
      <PageIntro description={t("guide.ui.pageIntro")} />
      <SectionCard title={t("guide.ui.pageTitle")} flush>
        {tasks.length === 0 ? <p className="px-5 pb-5 text-sm text-muted-foreground">{t("guide.ui.noTasks")}</p> : null}
        <ul className="flex flex-col divide-y divide-border">
          {tasks.map((key) => {
            const row = progress.find((item) => item.key === key);
            const running = row?.status === "paused" || row?.status === "in_progress";
            const total = GUIDED_TASKS[key].steps.length;
            return (
              <li key={key} data-guide-task={key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{t(taskTitleKey(key))}</p>
                  <p className="text-sm text-muted-foreground">{t(`guide.${key}.intro` as MessageKey)}</p>
                  {running ? <Badge variant="warning" className="mt-1">{t("guide.ui.stepOf", { step: row.step + 1, total })}</Badge> : null}
                  {!running && row?.everCompleted ? (
                    <Badge variant="success" className="mt-1">
                      <CircleCheck aria-hidden="true" />
                      {t("guide.ui.completed")}
                    </Badge>
                  ) : null}
                </div>
                <GuideStartButton task={key} restart={!running} label={t(running ? "guide.ui.resume" : row?.everCompleted ? "guide.ui.replay" : "guide.ui.start")} />
              </li>
            );
          })}
        </ul>
      </SectionCard>
    </PageContainer>
  );
}
