/** Public API of the inventory module. Other modules and the app import only from here. */
export { listAdjustments, recordAdjustment, type AdjustmentResult, type AdjustmentView } from "./adjustments";
export { OpeningLinesError, recordOpeningStock, type OpeningResult } from "./opening";
export { COST_VIEW, OWNER_APPROVAL_THRESHOLD_PAISE, STOCK_ADJUST, STOCK_OPENING, STOCK_VIEW } from "./permissions";
export {
  getProductStock,
  listOpeningCandidates,
  listStock,
  MOVEMENTS_PAGE_SIZE,
  rebuildStockCache,
  shopHasStockEntries,
  STOCK_PAGE_SIZE,
  STOCK_STATUS_FILTERS,
  stockAlerts,
  type StockMovementView,
  type StockRow,
  type StockStatus,
  type StockStatusFilter,
} from "./stock";
export { ADJUSTMENT_KINDS, openingLineSchema } from "./validation";
/** For billing: lock stock rows (product-id order), read on-hand quantity from the journal, append a movement with its cache update. */
export { appendMovement as appendStockMovement, ledgerTotals as stockOnHand, lockCacheRows as lockStockRows, type NewMovement } from "./ledger";
export {
  createGodown,
  godownList,
  godownStock,
  GODOWN_MANAGE,
  hasManyGodowns,
  listGodowns,
  listTransfers,
  renameGodown,
  resolveGodown,
  setGodownActive,
  transferInputSchema,
  transferOptions,
  transferStock,
  type GodownStockRow,
  type GodownView,
  type TransferOptions,
  type TransferResult,
  type TransferView,
} from "./godowns";
export { defaultGodownId, originalGodowns } from "./ledger";
export {
  addReservation,
  availableStock,
  consumeReservation,
  releaseOrderReservations,
  reservationOf,
  reservationsForOrder,
  reservedQuantities,
  type Availability,
} from "./reservations";
export { signedQuantity } from "./ledger";
export { DEFAULT_NOT_SELLING_DAYS, NOT_SELLING_CHOICES, stockNotSelling, type GodownStockAge, type NotSellingItem, type StockNotSelling } from "./intelligence";
