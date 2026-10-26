import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck, KeyRound, ListChecks, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getNavItem } from "@/config/navigation";
import { isOwnerPinSet, listStaff } from "@/modules/identity";
import { checkPagePermission } from "@/server/auth";
import { getBusinessSettings } from "@/modules/settings";
import { GstForm, InvoiceForm, ProfileForm } from "./business-forms";
import { AddStaffForm, PinForm, RevokeAccessButton, StaffActiveToggle, StaffRoleForm } from "./settings-forms";

const item = getNavItem("settings");

export const metadata: Metadata = { title: "Settings" };

const ROLE_LABELS = { owner: "Owner", manager: "Manager", cashier: "Cashier", inventory: "Inventory staff" } as const;

export default function SettingsPage() {
  return (
    <ProtectedPage title="Settings">
      <SettingsContent />
    </ProtectedPage>
  );
}

async function SettingsContent() {
  const { session, allowed: canManageStaff } = await checkPagePermission("staff.manage");
  const [staff, pinSet, business] = await Promise.all([canManageStaff ? listStaff(session) : Promise.resolve([]), isOwnerPinSet(session), getBusinessSettings(session)]);
  const isOwner = session.role === "owner";

  return (
    <PageContainer>
      <PageIntro
        description={item.description}
        actions={
          isOwner ? (
            <Link href="/settings/setup" className={buttonVariants({ size: "touch", variant: "outline" })}>
              <ListChecks aria-hidden="true" />
              Go-live setup & import
            </Link>
          ) : null
        }
      />

      {business.canEdit ? (
        <>
          <SectionCard title="Business details" description="Printed on every bill and statement.">
            <ProfileForm profile={business.profile} />
          </SectionCard>
          <div className="grid gap-6 xl:grid-cols-2">
            <SectionCard title="GST" description="How bills are taxed. Changes apply to bills made after saving; issued bills never change.">
              <GstForm gst={business.gst} />
            </SectionCard>
            <SectionCard title="Invoice" description="Numbering, payment details and terms on bills.">
              <InvoiceForm invoice={business.invoice} />
            </SectionCard>
          </div>
        </>
      ) : (
        <SectionCard title="Business details" description="Only the owner can change these.">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Shop</dt>
              <dd className="font-medium text-foreground">{business.profile.legalName ?? business.profile.name}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">GST</dt>
              <dd className="font-medium text-foreground">{business.gst.registration === "regular" ? `Registered · ${business.gst.gstin ?? "GSTIN missing"}` : business.gst.registration === "composition" ? "Composition scheme" : "Not registered"}</dd>
            </div>
          </dl>
        </SectionCard>
      )}

      {canManageStaff ? (
        <SectionCard title="Staff & access" description="Each person signs in with their own mobile number. Their role decides what they can open." flush>
          <div className="flex flex-col gap-5">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Name</TableHead>
                  <TableHead>Mobile</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-5 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {staff.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="pl-5 font-medium text-foreground">
                      {member.name}
                      {member.id === session.userId ? <span className="ml-1.5 text-xs text-muted-foreground">(you)</span> : null}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{member.phone}</TableCell>
                    <TableCell>
                      {member.role !== "owner" && isOwner ? (
                        <StaffRoleForm userId={member.id} currentRole={member.role} name={member.name} />
                      ) : (
                        <Badge variant={member.role === "owner" ? "info" : "neutral"}>{ROLE_LABELS[member.role]}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={member.isActive ? "success" : "neutral"}>{member.isActive ? "Active" : "Deactivated"}</Badge>
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
                Add a person
              </h3>
              <AddStaffForm />
            </div>
          </div>
        </SectionCard>
      ) : (
        <SectionCard title="Staff & access" description="Only the owner can add staff or change access.">
          <p className="text-sm text-muted-foreground">You&apos;re signed in as {ROLE_LABELS[session.role].toLowerCase()}. Ask the owner if your access needs to change.</p>
        </SectionCard>
      )}

      <SectionCard
        title="Owner approval PIN"
        description="Needed for discounts above a cashier's limit, credit beyond a customer's limit, and other approvals."
        action={
          pinSet ? (
            <Badge variant="success" className="h-6 gap-1.5 px-2.5">
              <CircleCheck aria-hidden="true" />
              Set
            </Badge>
          ) : (
            <Badge variant="warning" className="h-6 gap-1.5 px-2.5">
              <KeyRound aria-hidden="true" />
              Not set
            </Badge>
          )
        }
      >
        {isOwner ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">4 to 6 digits. Avoid easy PINs like 1111 or 1234. Five wrong entries lock approvals for 15 minutes.</p>
            <PinForm pinSet={pinSet} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Only the owner can set or change this PIN.</p>
        )}
      </SectionCard>

      <SectionCard title="Coming later" description="Other settings arrive with their modules.">
        <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
          {item.planned
            .filter((feature) => !feature.startsWith("Staff"))
            .map((feature) => (
              <li key={feature}>• {feature}</li>
            ))}
        </ul>
      </SectionCard>
    </PageContainer>
  );
}
