/** Public API of the pricing module. Other modules and the app import only from here. */
export { COST_VIEW, PRICING_MANAGE, requireQuotePermission } from "./permissions";
export { quoteForSession, type QuoteResult } from "./quote";
export {
  addCustomerRule,
  addSlab,
  describeRule,
  getPricingProduct,
  listAllProductRules,
  listPricingCustomers,
  listRulesForProduct,
  listSlabs,
  listPricingProducts,
  setCustomerRuleActive,
  setSlabActive,
  updateCustomerRule,
  updateSlabPrice,
  type CustomerRule,
  type Slab,
} from "./rules";
