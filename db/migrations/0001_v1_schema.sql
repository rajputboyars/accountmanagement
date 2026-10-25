CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"shop_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"role" text,
	"device_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"approval_id" uuid,
	"offline" boolean DEFAULT false NOT NULL,
	"ip" "inet"
);
--> statement-breakpoint
CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movements_kind_check" CHECK ("cash_movements"."kind" in ('withdrawal', 'bank_deposit', 'float_added')),
	CONSTRAINT "cash_movements_amount_check" CHECK ("cash_movements"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "day_closings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" text NOT NULL,
	"opening_cash_paise" bigint NOT NULL,
	"expected_cash_paise" bigint NOT NULL,
	"counted_cash_paise" bigint NOT NULL,
	"difference_paise" bigint NOT NULL,
	"difference_reason" text,
	"snapshot" jsonb NOT NULL,
	"closed_by" uuid NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"reopened_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_closings_shop_business_date_key" UNIQUE("shop_id","business_date"),
	CONSTRAINT "day_closings_status_check" CHECK ("day_closings"."status" in ('closed', 'reopened')),
	CONSTRAINT "day_closings_reason_check" CHECK ("day_closings"."difference_paise" = 0 or "day_closings"."difference_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"category" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"method" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'recorded' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_amount_check" CHECK ("expenses"."amount_paise" > 0),
	CONSTRAINT "expenses_method_check" CHECK ("expenses"."method" in ('cash', 'upi', 'bank')),
	CONSTRAINT "expenses_status_check" CHECK ("expenses"."status" in ('recorded', 'voided'))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_shop_name_key" UNIQUE("shop_id","name")
);
--> statement-breakpoint
CREATE TABLE "product_cost_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"cost_paise" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"factor" numeric(12, 3) NOT NULL,
	"retail_paise" bigint,
	"wholesale_paise" bigint,
	"barcode" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_units_product_unit_key" UNIQUE("product_id","unit"),
	CONSTRAINT "product_units_factor_check" CHECK ("product_units"."factor" > 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"sku" varchar(30) NOT NULL,
	"barcode" varchar(30),
	"name" varchar(120) NOT NULL,
	"category_id" uuid,
	"base_unit" text NOT NULL,
	"hsn" varchar(8) NOT NULL,
	"gst_rate_bp" integer NOT NULL,
	"cost_paise" bigint,
	"retail_paise" bigint NOT NULL,
	"wholesale_paise" bigint NOT NULL,
	"reorder_level" numeric(14, 3) DEFAULT '10' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_shop_sku_key" UNIQUE("shop_id","sku"),
	CONSTRAINT "products_gst_rate_check" CHECK ("products"."gst_rate_bp" in (0, 500, 1200, 1800, 2800)),
	CONSTRAINT "products_cost_check" CHECK ("products"."cost_paise" >= 0),
	CONSTRAINT "products_retail_check" CHECK ("products"."retail_paise" > 0),
	CONSTRAINT "products_wholesale_check" CHECK ("products"."wholesale_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_ref" text NOT NULL,
	"payload" jsonb NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone" varchar(10) NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"shop_id" uuid NOT NULL,
	"role" text NOT NULL,
	"permission" text NOT NULL,
	"allowed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_shop_id_role_permission_pk" PRIMARY KEY("shop_id","role","permission")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" varchar(10) NOT NULL,
	"role" text NOT NULL,
	"pin_hash" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('owner', 'manager', 'cashier', 'inventory'))
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"type" text NOT NULL,
	"file_key" text NOT NULL,
	"mapping" jsonb,
	"status" text NOT NULL,
	"summary" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_jobs_type_check" CHECK ("import_jobs"."type" in ('products', 'customers', 'suppliers')),
	CONSTRAINT "import_jobs_status_check" CHECK ("import_jobs"."status" in ('uploaded', 'previewed', 'committed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_job_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"data" jsonb NOT NULL,
	"result" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_result_check" CHECK ("import_rows"."result" in ('new', 'update', 'skip'))
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"fy" char(5) NOT NULL,
	"number" varchar(16) NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"approval_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustments_shop_fy_number_key" UNIQUE("shop_id","fy","number"),
	CONSTRAINT "stock_adjustments_kind_check" CHECK ("stock_adjustments"."kind" in ('return_in', 'damage', 'count'))
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"qty_base" numeric(14, 3) NOT NULL,
	"last_movement_id" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"shop_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"movement_date" date NOT NULL,
	"kind" text NOT NULL,
	"qty_base" numeric(14, 3) NOT NULL,
	"unit_cost_paise" bigint,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_kind_check" CHECK ("stock_movements"."kind" in ('opening', 'sale', 'sale_cancel', 'return_in', 'purchase', 'return_out', 'damage', 'count')),
	CONSTRAINT "stock_movements_qty_check" CHECK ("stock_movements"."qty_base" <> 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"shop_id" uuid NOT NULL,
	"party_type" text NOT NULL,
	"party_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"kind" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"debit_paise" bigint DEFAULT 0 NOT NULL,
	"credit_paise" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_party_type_check" CHECK ("ledger_entries"."party_type" in ('customer', 'supplier')),
	CONSTRAINT "ledger_entries_kind_check" CHECK ("ledger_entries"."kind" in ('opening', 'invoice', 'payment', 'credit_note', 'cancellation', 'correction', 'purchase', 'debit_note')),
	CONSTRAINT "ledger_entries_debit_check" CHECK ("ledger_entries"."debit_paise" >= 0),
	CONSTRAINT "ledger_entries_credit_check" CHECK ("ledger_entries"."credit_paise" >= 0),
	CONSTRAINT "ledger_entries_one_side_check" CHECK (("ledger_entries"."debit_paise" > 0) <> ("ledger_entries"."credit_paise" > 0))
);
--> statement-breakpoint
CREATE TABLE "party_balances" (
	"party_type" text NOT NULL,
	"party_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"balance_paise" bigint NOT NULL,
	"last_entry_id" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_balances_party_type_party_id_pk" PRIMARY KEY("party_type","party_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" varchar(10),
	"gstin" varchar(15),
	"area" text,
	"type" text NOT NULL,
	"credit_limit_paise" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_type_check" CHECK ("customers"."type" in ('walkin', 'retail', 'wholesale')),
	CONSTRAINT "customers_credit_limit_check" CHECK ("customers"."credit_limit_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" varchar(15),
	"gstin" varchar(15),
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"fy" char(5) NOT NULL,
	"receipt_number" varchar(16),
	"direction" text NOT NULL,
	"party_type" text NOT NULL,
	"party_id" uuid,
	"invoice_id" uuid,
	"credit_note_id" uuid,
	"method" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reference" varchar(40),
	"business_date" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"device_id" uuid,
	"status" text DEFAULT 'recorded' NOT NULL,
	"reversed_by_payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_direction_check" CHECK ("payments"."direction" in ('in', 'out')),
	CONSTRAINT "payments_party_type_check" CHECK ("payments"."party_type" in ('customer', 'supplier', 'none')),
	CONSTRAINT "payments_method_check" CHECK ("payments"."method" in ('cash', 'upi', 'card', 'bank', 'cheque')),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" in ('recorded', 'reversed')),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "customer_price_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid,
	"kind" text NOT NULL,
	"value" integer NOT NULL,
	"min_qty" numeric(14, 3) DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_price_rules_kind_check" CHECK ("customer_price_rules"."kind" in ('pct', 'fixed')),
	CONSTRAINT "customer_price_rules_value_check" CHECK ("customer_price_rules"."value" > 0)
);
--> statement-breakpoint
CREATE TABLE "price_slabs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"min_qty" numeric(14, 3) NOT NULL,
	"price_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_slabs_product_min_qty_key" UNIQUE("product_id","min_qty"),
	CONSTRAINT "price_slabs_min_qty_check" CHECK ("price_slabs"."min_qty" > 1),
	CONSTRAINT "price_slabs_price_check" CHECK ("price_slabs"."price_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"purchase_order_line_id" uuid,
	"product_id" uuid NOT NULL,
	"qty_base" numeric(14, 3) NOT NULL,
	"unit_cost_paise" bigint NOT NULL,
	"line_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipt_lines_qty_check" CHECK ("goods_receipt_lines"."qty_base" > 0)
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"fy" char(5) NOT NULL,
	"number" varchar(16) NOT NULL,
	"purchase_order_id" uuid,
	"supplier_id" uuid NOT NULL,
	"supplier_bill_no" varchar(30),
	"supplier_bill_date" date,
	"received_date" date NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"gst_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipts_shop_fy_number_key" UNIQUE("shop_id","fy","number")
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"factor" numeric(12, 3) DEFAULT '1' NOT NULL,
	"qty_ordered" numeric(14, 3) NOT NULL,
	"cost_paise_per_unit" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_lines_qty_check" CHECK ("purchase_order_lines"."qty_ordered" > 0),
	CONSTRAINT "purchase_order_lines_cost_check" CHECK ("purchase_order_lines"."cost_paise_per_unit" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"fy" char(5) NOT NULL,
	"number" varchar(16) NOT NULL,
	"supplier_id" uuid NOT NULL,
	"order_date" date NOT NULL,
	"status" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_shop_fy_number_key" UNIQUE("shop_id","fy","number"),
	CONSTRAINT "purchase_orders_status_check" CHECK ("purchase_orders"."status" in ('ordered', 'partially_received', 'received', 'closed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "credit_note_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"base_qty" numeric(14, 3) NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"restock" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_note_lines_base_qty_check" CHECK ("credit_note_lines"."base_qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"fy" char(5) NOT NULL,
	"number" varchar(16) NOT NULL,
	"invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"reason" text NOT NULL,
	"settlement" text NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"round_off_paise" integer NOT NULL,
	"total_paise" bigint NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_shop_fy_number_key" UNIQUE("shop_id","fy","number"),
	CONSTRAINT "credit_notes_settlement_check" CHECK ("credit_notes"."settlement" in ('ledger', 'cash', 'upi', 'bank'))
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"factor" numeric(12, 3) DEFAULT '1' NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"base_qty" numeric(14, 3) NOT NULL,
	"rate_paise" bigint NOT NULL,
	"rate_reason" text NOT NULL,
	"line_paise" bigint NOT NULL,
	"line_discount_paise" bigint DEFAULT 0 NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"gst_rate_bp" integer NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"unit_cost_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_lines_invoice_line_no_key" UNIQUE("invoice_id","line_no"),
	CONSTRAINT "invoice_lines_qty_check" CHECK ("invoice_lines"."qty" > 0),
	CONSTRAINT "invoice_lines_base_qty_check" CHECK ("invoice_lines"."base_qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"fy" char(5) NOT NULL,
	"number" varchar(16) NOT NULL,
	"business_date" date NOT NULL,
	"customer_id" uuid NOT NULL,
	"price_list" text NOT NULL,
	"device_id" uuid,
	"created_by" uuid NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"subtotal_paise" bigint NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"round_off_paise" integer NOT NULL,
	"total_paise" bigint NOT NULL,
	"paid_now_paise" bigint DEFAULT 0 NOT NULL,
	"cost_complete" boolean NOT NULL,
	"discount_approval_id" uuid,
	"corrects_invoice_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"client_created_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_shop_fy_number_key" UNIQUE("shop_id","fy","number"),
	CONSTRAINT "invoices_status_check" CHECK ("invoices"."status" in ('issued', 'cancelled')),
	CONSTRAINT "invoices_price_list_check" CHECK ("invoices"."price_list" in ('retail', 'wholesale')),
	CONSTRAINT "invoices_round_off_check" CHECK ("invoices"."round_off_paise" between -50 and 50),
	CONSTRAINT "invoices_paid_now_check" CHECK ("invoices"."paid_now_paise" between 0 and "invoices"."total_paise"),
	CONSTRAINT "invoices_total_check" CHECK ("invoices"."total_paise" = "invoices"."taxable_paise" + "invoices"."cgst_paise" + "invoices"."sgst_paise" + "invoices"."igst_paise" + "invoices"."round_off_paise")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"last_sync_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"series" text NOT NULL,
	"fy" char(5) NOT NULL,
	"first_value" integer NOT NULL,
	"last_value" integer NOT NULL,
	"next_value" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_blocks_range" CHECK ("number_blocks"."first_value" <= "number_blocks"."next_value" and "number_blocks"."next_value" <= "number_blocks"."last_value" + 1)
);
--> statement-breakpoint
CREATE TABLE "number_series" (
	"shop_id" uuid NOT NULL,
	"series" text NOT NULL,
	"fy" char(5) NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_series_shop_id_series_fy_pk" PRIMARY KEY("shop_id","series","fy")
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"gstin" varchar(15),
	"state_code" char(2) NOT NULL,
	"address" text,
	"phone" varchar(15),
	"fy_start_month" smallint DEFAULT 4 NOT NULL,
	"opening_cash_paise" bigint DEFAULT 0 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"shop_id" uuid NOT NULL,
	"key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"status_code" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_shop_id_key_pk" PRIMARY KEY("shop_id","key")
);
--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_closings" ADD CONSTRAINT "day_closings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_closings" ADD CONSTRAINT "day_closings_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_closings" ADD CONSTRAINT "day_closings_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_cost_history" ADD CONSTRAINT "product_cost_history_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversed_by_payment_id_payments_id_fk" FOREIGN KEY ("reversed_by_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_price_rules" ADD CONSTRAINT "customer_price_rules_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_price_rules" ADD CONSTRAINT "customer_price_rules_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_price_rules" ADD CONSTRAINT "customer_price_rules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_slabs" ADD CONSTRAINT "price_slabs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_discount_approval_id_approvals_id_fk" FOREIGN KEY ("discount_approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_corrects_invoice_id_invoices_id_fk" FOREIGN KEY ("corrects_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_blocks" ADD CONSTRAINT "number_blocks_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_shop_at_idx" ON "audit_log" USING btree ("shop_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_shop_barcode_key" ON "products" USING btree ("shop_id","barcode") WHERE "products"."barcode" is not null;--> statement-breakpoint
CREATE INDEX "products_name_trgm" ON "products" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "otp_requests_phone_expires_idx" ON "otp_requests" USING btree ("phone","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_shop_phone_key" ON "users" USING btree ("shop_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "one_owner_per_shop" ON "users" USING btree ("shop_id") WHERE "users"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "stock_movements_product_idx" ON "stock_movements" USING btree ("product_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_source_key" ON "stock_movements" USING btree ("source_type","source_id","product_id","kind");--> statement-breakpoint
CREATE INDEX "ledger_entries_party_idx" ON "ledger_entries" USING btree ("party_type","party_id","entry_date","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_source_key" ON "ledger_entries" USING btree ("source_type","source_id","kind","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_shop_phone_key" ON "customers" USING btree ("shop_id","phone") WHERE "customers"."phone" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "one_walkin_per_shop" ON "customers" USING btree ("shop_id") WHERE "customers"."type" = 'walkin';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_no_duplicate_ref" ON "payments" USING btree ("shop_id","method","reference") WHERE "payments"."reference" is not null and "payments"."status" = 'recorded' and "payments"."method" in ('upi', 'cheque', 'bank');--> statement-breakpoint
CREATE INDEX "payments_shop_business_date_idx" ON "payments" USING btree ("shop_id","business_date");--> statement-breakpoint
CREATE INDEX "payments_party_business_date_idx" ON "payments" USING btree ("party_type","party_id","business_date");--> statement-breakpoint
CREATE INDEX "customer_price_rules_customer_idx" ON "customer_price_rules" USING btree ("customer_id") WHERE "customer_price_rules"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_supplier_bill_key" ON "goods_receipts" USING btree ("supplier_id","supplier_bill_no") WHERE "goods_receipts"."supplier_bill_no" is not null;--> statement-breakpoint
CREATE INDEX "invoice_lines_product_idx" ON "invoice_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "invoices_shop_business_date_idx" ON "invoices" USING btree ("shop_id","business_date");--> statement-breakpoint
CREATE INDEX "invoices_customer_business_date_idx" ON "invoices" USING btree ("customer_id","business_date");