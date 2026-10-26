-- Hand-added. New permissions `approvals.view` and `approvals.decide` for existing shops.
INSERT INTO "role_permissions" ("shop_id", "role", "permission", "allowed")
SELECT "shops"."id", "roles"."role", 'approvals.view', true
FROM "shops" CROSS JOIN (VALUES ('owner'), ('manager'), ('cashier'), ('inventory')) AS "roles"("role")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("shop_id", "role", "permission", "allowed")
SELECT "shops"."id", "roles"."role", 'approvals.decide', "roles"."role" = 'owner'
FROM "shops" CROSS JOIN (VALUES ('owner'), ('manager'), ('cashier'), ('inventory')) AS "roles"("role")
ON CONFLICT DO NOTHING;
