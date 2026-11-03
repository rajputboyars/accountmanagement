import type { Metadata } from "next";
import Link from "next/link";
import { Bell, BellOff } from "lucide-react";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getNotificationPreferences, listNotifications } from "@/modules/identity";
import { refreshBusinessAlerts } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { notificationText, timeLabel } from "@/shared/i18n/labels";
import { markReadAction, setPreferenceAction } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("common.notifications") };
}

export default function NotificationsPage() {
  return (
    <ProtectedPage title="Notifications" guide="notifications">
      <NotificationsContent />
    </ProtectedPage>
  );
}

async function NotificationsContent() {
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  await refreshBusinessAlerts(session);
  const [items, preferences] = await Promise.all([listNotifications(session, { limit: 100 }), getNotificationPreferences(session)]);
  const unread = items.filter((item) => !item.readAt).length;
  return (
    <PageContainer className="max-w-4xl">
      <PageIntro description={t("notifications.intro")} />
      <SectionCard
        title={t("notifications.inbox")}
        description={unread ? t("notifications.unreadCount", { count: unread }) : t("notifications.allRead")}
        action={
          unread ? (
            <form action={markReadAction}>
              <Button type="submit" variant="outline" size="touch">
                {t("notifications.markAllRead")}
              </Button>
            </form>
          ) : null
        }
        flush
      >
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 pb-8 text-center">
            <Bell className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{t("notifications.empty")}</p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border pb-2">
            {items.map((item) => {
              const text = notificationText(item, t, language);
              return (
              <li key={item.id} className={`flex flex-wrap items-start justify-between gap-3 px-5 py-3 ${item.readAt ? "" : "bg-teal-soft/40"}`}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    {item.readAt ? null : <span className="size-2 rounded-full bg-teal" aria-label={t("notifications.unread")} />}
                    {item.href ? (
                      <Link href={item.href} className="hover:underline">
                        {text.title}
                      </Link>
                    ) : (
                      text.title
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">{text.body}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="neutral">{t(`notifications.kind.${item.kind}`)}</Badge>
                    {timeLabel(item.createdAt, language)}
                  </p>
                </div>
                {item.readAt ? null : (
                  <form action={markReadAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <Button type="submit" variant="ghost" size="touch">
                      {t("notifications.markRead")}
                    </Button>
                  </form>
                )}
              </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard title={t("notifications.prefsTitle")} description={t("notifications.prefsHelp")} flush>
        <ul className="flex flex-col divide-y divide-border pb-2">
          {preferences.map((preference) => (
            <li key={preference.kind} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
              <span className="flex items-center gap-2 text-foreground">
                {preference.inApp ? <Bell className="size-4 text-teal-strong" aria-hidden="true" /> : <BellOff className="size-4 text-muted-foreground" aria-hidden="true" />}
                {t(`notifications.kind.${preference.kind}`)}
              </span>
              <form action={setPreferenceAction}>
                <input type="hidden" name="kind" value={preference.kind} />
                {preference.inApp ? null : <input type="hidden" name="inApp" value="on" />}
                <Button type="submit" variant="outline" size="touch" aria-label={t(preference.inApp ? "notifications.turnOffKind" : "notifications.turnOnKind", { kind: t(`notifications.kind.${preference.kind}`) })}>
                  {t(preference.inApp ? "notifications.turnOff" : "notifications.turnOn")}
                </Button>
              </form>
            </li>
          ))}
        </ul>
      </SectionCard>
    </PageContainer>
  );
}
