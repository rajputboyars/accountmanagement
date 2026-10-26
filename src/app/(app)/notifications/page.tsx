import type { Metadata } from "next";
import Link from "next/link";
import { Bell, BellOff } from "lucide-react";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getNotificationPreferences, listNotifications, NOTIFICATION_KIND_LABELS } from "@/modules/identity";
import { refreshBusinessAlerts } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { markReadAction, setPreferenceAction } from "./actions";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <ProtectedPage title="Notifications">
      <NotificationsContent />
    </ProtectedPage>
  );
}

const timeText = (date: Date) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(date);

async function NotificationsContent() {
  const session = await requireSession();
  await refreshBusinessAlerts(session);
  const [items, preferences] = await Promise.all([listNotifications(session, { limit: 100 }), getNotificationPreferences(session)]);
  const unread = items.filter((item) => !item.readAt).length;
  return (
    <PageContainer className="max-w-4xl">
      <PageIntro description="Alerts for you: low stock, overdue dues, approvals and WhatsApp messages that failed. Nothing here is sent to your phone." />
      <SectionCard
        title="Inbox"
        description={unread ? `${unread} unread` : "All read"}
        action={
          unread ? (
            <form action={markReadAction}>
              <Button type="submit" variant="outline" size="touch">
                Mark all read
              </Button>
            </form>
          ) : null
        }
        flush
      >
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 pb-8 text-center">
            <Bell className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">No notifications yet.</p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border pb-2">
            {items.map((item) => (
              <li key={item.id} className={`flex flex-wrap items-start justify-between gap-3 px-5 py-3 ${item.readAt ? "" : "bg-teal-soft/40"}`}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    {item.readAt ? null : <span className="size-2 rounded-full bg-teal" aria-label="Unread" />}
                    {item.href ? (
                      <Link href={item.href} className="hover:underline">
                        {item.title}
                      </Link>
                    ) : (
                      item.title
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">{item.body}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="neutral">{NOTIFICATION_KIND_LABELS[item.kind]}</Badge>
                    {timeText(item.createdAt)}
                  </p>
                </div>
                {item.readAt ? null : (
                  <form action={markReadAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <Button type="submit" variant="ghost" size="touch">
                      Mark read
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="What to show me" description="Turn off kinds of alerts you don't need. This only affects you." flush>
        <ul className="flex flex-col divide-y divide-border pb-2">
          {preferences.map((preference) => (
            <li key={preference.kind} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
              <span className="flex items-center gap-2 text-foreground">
                {preference.inApp ? <Bell className="size-4 text-teal-strong" aria-hidden="true" /> : <BellOff className="size-4 text-muted-foreground" aria-hidden="true" />}
                {preference.label}
              </span>
              <form action={setPreferenceAction}>
                <input type="hidden" name="kind" value={preference.kind} />
                {preference.inApp ? null : <input type="hidden" name="inApp" value="on" />}
                <Button type="submit" variant="outline" size="touch" aria-label={`${preference.inApp ? "Turn off" : "Turn on"} ${preference.label}`}>
                  {preference.inApp ? "Turn off" : "Turn on"}
                </Button>
              </form>
            </li>
          ))}
        </ul>
      </SectionCard>
    </PageContainer>
  );
}
