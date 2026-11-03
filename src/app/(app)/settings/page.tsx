import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck, KeyRound, ListChecks, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { isOwnerPinSet, listStaff } from "@/modules/identity";
import { checkPagePermission } from "@/server/auth";
import { getBusinessSettings } from "@/modules/settings";
import { getT } from "@/server/i18n";
import { GstForm, InvoiceForm, ProfileForm } from "./business-forms";
import { AddStaffForm, PinForm, RevokeAccessButton, StaffActiveToggle, StaffRoleForm } from "./settings-forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("nav.settings.label") };
}

const ROLE_KEYS = { owner: "role.owner", manager: "role.manager", cashier: "role.cashier", inventory: "settings.roleInventoryStaff" } as const;
const ELSEWHERE_KEYS = ["settings.elsewhere.import", "settings.elsewhere.language", "settings.elsewhere.theme"] as const;

export default function SettingsPage() {
  return (
    <ProtectedPage title="Settings" guide="settings">
      <SettingsContent />
    </ProtectedPage>
  );
}

async function SettingsContent() {
  const { session, allowed: canManageStaff } = await checkPagePermission("staff.manage");
  const [staff, pinSet, business] = await Promise.all([canManageStaff ? listStaff(session) : Promise.resolve([]), isOwnerPinSet(session), getBusinessSettings(session)]);
  const isOwner = session.role === "owner";
  const t = await getT();

  return (
    <PageContainer>
      <PageIntro
        description={t("nav.settings.description")}
        actions={
          isOwner ? (
            <Link href="/settings/setup" className={buttonVariants({ size: "touch", variant: "outline" })}>
              <ListChecks aria-hidden="true" />
              {t("settings.goLive")}
            </Link>
          ) : null
        }
      />

      {business.canEdit ? (
        <>
          <SectionCard title={t("settings.business")} description={t("settings.businessHelp")}>
            <ProfileForm profile={business.profile} />
          </SectionCard>
          <div className="grid gap-6 xl:grid-cols-2">
            <SectionCard title={t("settings.gst")} description={t("settings.gstHelp")}>
              <GstForm gst={business.gst} />
            </SectionCard>
            <SectionCard title={t("settings.invoice")} description={t("settings.invoiceHelp")}>
              <InvoiceForm invoice={business.invoice} />
            </SectionCard>
          </div>
        </>
      ) : (
        <SectionCard title={t("settings.business")} description={t("settings.businessOwnerOnly")}>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t("settings.shop")}</dt>
              <dd className="font-medium text-foreground">{business.profile.legalName ?? business.profile.name}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("settings.gst")}</dt>
              <dd className="font-medium text-foreground">{business.gst.registration === "regular" ? t("settings.gstRegistered", { gstin: business.gst.gstin ?? t("settings.gstinMissing") }) : business.gst.registration === "composition" ? t("settings.compositionScheme") : t("settings.notRegistered")}</dd>
            </div>
          </dl>
        </SectionCard>
      )}

      {canManageStaff ? (
        <SectionCard title={t("settings.staff")} description={t("settings.staffHelp")} flush>
          <div className="flex flex-col gap-5">
            <Table className="stack-table stack-table-flush">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">{t("common.name")}</TableHead>
                  <TableHead>{t("settings.mobile")}</TableHead>
                  <TableHead>{t("settings.role")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead className="pr-5 text-right">
                    <span className="sr-only">{t("settings.actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {staff.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell data-title className="pl-5 font-medium text-foreground">
                      {member.name}
                      {member.id === session.userId ? <span className="ml-1.5 text-xs text-muted-foreground">{t("settings.you")}</span> : null}
                    </TableCell>
                    <TableCell data-label={t("settings.mobile")} className="tabular-nums text-muted-foreground">{member.phone}</TableCell>
                    <TableCell data-label={t("settings.role")}>
                      {member.role !== "owner" && isOwner ? (
                        <StaffRoleForm userId={member.id} currentRole={member.role} name={member.name} />
                      ) : (
                        <Badge variant={member.role === "owner" ? "info" : "neutral"}>{t(ROLE_KEYS[member.role])}</Badge>
                      )}
                    </TableCell>
                    <TableCell data-key>
                      <Badge variant={member.isActive ? "success" : "neutral"}>{t(member.isActive ? "settings.active" : "settings.deactivated")}</Badge>
                    </TableCell>
                    <TableCell className="pr-5 text-right">
                      {member.role !== "owner" && member.id !== session.userId ? (
                        <div className="flex items-center justify-end gap-2">
                          <RevokeAccessButton userId={member.id} name={member.name} />
                          <StaffActiveToggle userId={member.id} active={member.isActive} name={member.name} />
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex flex-col gap-3 border-t border-border px-5 pt-5">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Users className="size-4" aria-hidden="true" />
                {t("settings.addPerson")}
              </h3>
              <AddStaffForm />
            </div>
          </div>
        </SectionCard>
      ) : (
        <SectionCard title={t("settings.staff")} description={t("settings.staffOwnerOnly")}>
          <p className="text-sm text-muted-foreground">{t("settings.signedInAsRole", { role: t(ROLE_KEYS[session.role]) })}</p>
        </SectionCard>
      )}

      <SectionCard
        title={t("settings.pin")}
        description={t("settings.pinHelp")}
        action={
          pinSet ? (
            <Badge variant="success" className="h-6 gap-1.5 px-2.5">
              <CircleCheck aria-hidden="true" />
              {t("settings.pinIsSet")}
            </Badge>
          ) : (
            <Badge variant="warning" className="h-6 gap-1.5 px-2.5">
              <KeyRound aria-hidden="true" />
              {t("settings.pinNotSet")}
            </Badge>
          )
        }
      >
        {isOwner ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{t("settings.pinRules")}</p>
            <PinForm pinSet={pinSet} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("settings.pinOwnerOnly")}</p>
        )}
      </SectionCard>

      <SectionCard title={t("settings.later")} description={t("settings.laterHelp")}>
        <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
          {ELSEWHERE_KEYS.map((feature) => (
            <li key={feature}>• {t(feature)}</li>
          ))}
        </ul>
      </SectionCard>
    </PageContainer>
  );
}
