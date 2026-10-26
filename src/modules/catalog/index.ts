/** Public API of the catalog module. Other modules and the app import only from here. */
export { CATALOG_MANAGE, CATALOG_VIEW, COST_VIEW } from "./permissions";
export {
  createProduct,
  exportProducts,
  getProduct,
  listCategories,
  listProducts,
  PRODUCT_PAGE_SIZE,
  searchShopProducts,
  setProductActive,
  trimFactor,
  updateProduct,
  type Conversion,
  type ProductDetail,
  type ProductFilters,
  type ProductPage,
  type ProductListItem,
  type ProductStatusFilter,
} from "./products";
export { addProductUnit, setProductUnitActive, updateProductUnitFactor } from "./product-units";
export { createUnit, DEFAULT_UNITS, listUnits, seedDefaultUnits, setUnitActive, type Unit } from "./units";
export { GST_RATE_OPTIONS, productInputSchema } from "./validation";
export { loadProductNames, loadProductPricingInputs, type ProductPricingInputs } from "./pricing-inputs";
export { applyReceivedCost, listShopProductsForStock, loadProductsForStock, lockProductsForStock, type ProductStockInputs, type ProductStockUnits } from "./stock-inputs";
