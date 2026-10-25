import { check, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, oneOf } from "../../server/schema-helpers";

/** Owned by the imports module: uploaded spreadsheets, previewed row by row before commit. */

export const IMPORT_TYPES = ["products", "customers", "suppliers"] as const;
export const IMPORT_STATUSES = ["uploaded", "previewed", "committed", "failed"] as const;
export const IMPORT_ROW_RESULTS = ["new", "update", "skip"] as const;

export const importJobs = pgTable(
  "import_jobs",
  {
    id: id(),
    shopId: uuid("shop_id").notNull(),
    type: text("type").$type<(typeof IMPORT_TYPES)[number]>().notNull(),
    fileKey: text("file_key").notNull(),
    mapping: jsonb("mapping"),
    status: text("status").$type<(typeof IMPORT_STATUSES)[number]>().notNull(),
    summary: jsonb("summary"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("import_jobs_type_check", oneOf(t.type, IMPORT_TYPES)), check("import_jobs_status_check", oneOf(t.status, IMPORT_STATUSES))],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: id(),
    importJobId: uuid("import_job_id")
      .notNull()
      .references(() => importJobs.id),
    rowNo: integer("row_no").notNull(),
    data: jsonb("data").notNull(),
    result: text("result").$type<(typeof IMPORT_ROW_RESULTS)[number]>(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [check("import_rows_result_check", oneOf(t.result, IMPORT_ROW_RESULTS))],
);
