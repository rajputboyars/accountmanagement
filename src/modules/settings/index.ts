/** Public API of the settings module. */
export { DOCUMENT_SERIES, isSetupComplete, runFirstTimeSetup, setupSchema, type SetupInput } from "./setup";
export { getCurrentShop, type ShopSummary } from "./shop";
export { takeDocumentNumber, type DocumentSeries } from "./numbering";
export { shopOpeningCash } from "./shop";
export { getBusinessSettings, invoiceProfile, loadTaxSettings, SETTINGS_EDIT, updateBusinessProfile, updateGstSettings, updateInvoiceSettings, type BusinessSettings, type InvoiceExtras } from "./business";
