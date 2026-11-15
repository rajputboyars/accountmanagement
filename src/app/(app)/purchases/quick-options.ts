import { CATALOG_MANAGE, COST_VIEW, listUnits } from "@/modules/catalog";
import { hasPermission } from "@/modules/identity";
import { PURCHASES_EDIT } from "@/modules/purchasing";
import { getBusinessSettings } from "@/modules/settings";
import type { requireSession } from "@/server/auth";
import type { getT } from "@/server/i18n";
import { unitName } from "@/shared/i18n/unit-labels";

/** Quick-add options for the purchase form: only what this person's permissions allow. */
export async function quickOptions(session: Awaited<ReturnType<typeof requireSession>>, t: Awaited<ReturnType<typeof getT>>) {
  const canEdit = await hasPermission(session, PURCHASES_EDIT);
  const productCreate =
    canEdit && (await hasPermission(session, CATALOG_MANAGE))
      ? await Promise.all([listUnits(session), getBusinessSettings(session), hasPermission(session, COST_VIEW)]).then(([units, settings, canSeeCost]) => ({
          units: units.map((unit) => ({ code: unit.code, label: unitName(t, unit.code, unit.name) })),
          gstRates: settings.gst.gstRatesBp,
          canSeeCost,
        }))
      : null;
  return { canAddSupplier: canEdit, canLinkProducts: canEdit, productCreate };
}
