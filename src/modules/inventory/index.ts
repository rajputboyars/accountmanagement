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
  STOCK_PAGE_SIZE,
  STOCK_STATUS_FILTERS,
  type StockMovementView,
  type StockRow,
  type StockStatus,
  type StockStatusFilter,
} from "./stock";
export { ADJUSTMENT_KINDS } from "./validation";
