/**
 * The approved words for Nexora's business concepts. Use these when writing any dictionary entry, so one
 * concept never gets two names. tests/unit/i18n.test.ts checks the dictionaries against this list.
 *
 * Hinglish rules: everyday spoken words in English letters; one or two words on menus and buttons; menus are
 * nouns, buttons are commands ("Paisa lo"); singular "Customer" and "Supplier", even for many.
 * Hindi rules: clear everyday Devanagari; sentences end in "।". Keep GST, GSTIN, HSN, UPI as written.
 * Never translate names, notes or addresses that people entered.
 */
export type GlossaryTerm = { en: string; hinglish: string; hi: string; meaning: string };

export const GLOSSARY = {
  // Sales and billing
  sale: { en: "Sale", hinglish: "Sale", hi: "बिक्री", meaning: "Goods sold; used for totals and reports." },
  bill: { en: "Bill", hinglish: "Bill", hi: "बिल", meaning: "The document given to a customer; also used for invoice." },
  newBill: { en: "New bill", hinglish: "Naya bill", hi: "नया बिल", meaning: "Button that starts a bill." },
  retail: { en: "Retail", hinglish: "Retail", hi: "खुदरा", meaning: "Single-piece price type." },
  wholesale: { en: "Wholesale", hinglish: "Wholesale", hi: "थोक", meaning: "Bulk price type." },
  walkIn: { en: "Walk-in customer", hinglish: "Walk-in customer", hi: "काउंटर ग्राहक", meaning: "A buyer with no saved account." },
  discount: { en: "Discount", hinglish: "Discount", hi: "छूट", meaning: "Money taken off the price." },
  sellingPrice: { en: "Selling price", hinglish: "Bechne ka rate", hi: "बिक्री दाम", meaning: "The price the customer pays." },
  priceSlab: { en: "Price slab", hinglish: "Quantity rate", hi: "मात्रा का दाम", meaning: "A lower rate for buying more." },
  cancelled: { en: "Cancelled", hinglish: "Cancel", hi: "रद्द", meaning: "The bill no longer counts." },

  // Purchases and suppliers
  purchase: { en: "Purchase", hinglish: "Kharidari", hi: "खरीद", meaning: "Goods bought for the shop." },
  supplier: { en: "Supplier", hinglish: "Supplier", hi: "सप्लायर", meaning: "The person or firm you buy from." },
  purchaseOrder: { en: "Purchase order", hinglish: "Order", hi: "खरीद ऑर्डर", meaning: "Goods requested but not yet received." },
  goodsOrdered: { en: "Goods ordered", hinglish: "Mangaya maal", hi: "मँगाया सामान", meaning: "Goods on an order that may not have come yet." },
  goodsReceived: { en: "Goods received", hinglish: "Aaya maal", hi: "आया सामान", meaning: "Goods that actually reached the shop." },
  purchasePrice: { en: "Purchase price", hinglish: "Supplier rate", hi: "सप्लायर का दाम", meaning: "The rate on one order or supplier bill; the product's cost price is worked out from these." },
  supplierPayment: { en: "Supplier payment", hinglish: "Supplier ko payment", hi: "सप्लायर को भुगतान", meaning: "Money you paid out." },

  // Customers and payments
  customer: { en: "Customer", hinglish: "Customer", hi: "ग्राहक", meaning: "The buyer; also the menu name, never Udhaar." },
  creditSale: { en: "Credit sale", hinglish: "Udhaar", hi: "उधार", meaning: "A sale paid for later." },
  creditLimit: { en: "Credit limit", hinglish: "Udhaar limit", hi: "उधार सीमा", meaning: "The most credit a customer may have." },
  receivable: { en: "To collect", hinglish: "Lena hai", hi: "लेना है", meaning: "Total customers still owe you." },
  payable: { en: "To pay", hinglish: "Dena hai", hi: "देना है", meaning: "Total you still owe suppliers." },
  outstanding: { en: "Outstanding", hinglish: "Baaki", hi: "बाकी", meaning: "The unpaid amount on an account." },
  paymentPending: { en: "Payment pending", hinglish: "Payment baaki", hi: "भुगतान बाकी", meaning: "Money not yet paid; the opposite of money received." },
  advance: { en: "Advance", hinglish: "Advance", hi: "अग्रिम", meaning: "Money paid before it was owed, kept on the account." },
  broughtForward: { en: "Brought forward", hinglish: "Pichhla baaki", hi: "पिछला बाकी", meaning: "The balance before the dates shown on a statement." },
  debit: { en: "Debit", hinglish: "Juda", hi: "जुड़ा", meaning: "A statement column: added to what the customer owes." },
  credit: { en: "Credit", hinglish: "Jama", hi: "जमा", meaning: "A statement column: taken off what the customer owes." },
  messageLanguage: { en: "Message language", hinglish: "Message ki bhasha", hi: "संदेश की भाषा", meaning: "The language a customer reads messages in; separate from the staff screen language." },
  overdue: { en: "Overdue", hinglish: "Late", hi: "तारीख निकल गई", meaning: "Past the due date; not all unpaid money." },
  dueDate: { en: "Due date", hinglish: "Tareekh", hi: "देय तारीख", meaning: "When payment should arrive." },
  moneyReceived: { en: "Money received", hinglish: "Aaya paisa", hi: "मिला पैसा", meaning: "Total money that came in." },
  collectPayment: { en: "Collect payment", hinglish: "Paisa lo", hi: "भुगतान लें", meaning: "Button that records money from a customer." },
  oldDues: { en: "Old dues", hinglish: "Purana udhaar", hi: "पुराना उधार", meaning: "Payment against earlier bills." },
  receipt: { en: "Receipt", hinglish: "Raseed", hi: "रसीद", meaning: "Proof of a payment." },
  statement: { en: "Statement", hinglish: "Khata", hi: "खाता", meaning: "One account's full history." },

  // Goods, services and stock
  physicalGoods: { en: "Product", hinglish: "Maal", hi: "सामान", meaning: "Physical goods the shop sells." },
  service: { en: "Service", hinglish: "Service", hi: "सेवा", meaning: "Work sold rather than goods; never called Maal." },
  stock: { en: "Stock", hinglish: "Stock", hi: "स्टॉक", meaning: "Quantity in the shop." },
  availableStock: { en: "Available stock", hinglish: "Abhi ka stock", hi: "उपलब्ध स्टॉक", meaning: "What is in the shop now, worked out from every stock entry." },
  openingStock: { en: "Opening stock", hinglish: "Shuru ka stock", hi: "शुरुआती स्टॉक", meaning: "The first count entered in Nexora." },
  unit: { en: "Unit", hinglish: "Unit", hi: "इकाई", meaning: "Pcs, box, kg and so on." },
  lowStock: { en: "Low stock", hinglish: "Kam stock", hi: "कम स्टॉक", meaning: "At or below the warning level." },
  outOfStock: { en: "Out", hinglish: "Khatam", hi: "खत्म", meaning: "Nothing left." },
  reorderLevel: { en: "Reorder level", hinglish: "Mangane ka level", hi: "मँगाने का स्तर", meaning: "The quantity at which to reorder." },
  reorderNow: { en: "Reorder now", hinglish: "Abhi mangao", hi: "अभी मँगाएँ", meaning: "Action or status." },

  // Expenses and cash
  expense: { en: "Expense", hinglish: "Kharcha", hi: "खर्च", meaning: "Shop running costs." },
  cashbook: { en: "Cashbook", hinglish: "Cashbook", hi: "कैशबुक", meaning: "The screen for daily cash." },
  cashDrawer: { en: "Cash drawer", hinglish: "Galla", hi: "गल्ला", meaning: "Physical cash at the counter." },
  closeDay: { en: "Close the day", hinglish: "Din band karo", hi: "दिन बंद करें", meaning: "The daily closing action." },
  cash: { en: "Cash", hinglish: "Cash", hi: "नकद", meaning: "The payment method." },

  // Profit
  costPrice: { en: "Cost price", hinglish: "Kharid rate", hi: "खरीद दाम", meaning: "What you paid per unit." },
  grossProfit: { en: "Gross profit", hinglish: "Maal ka munafa", hi: "सामान पर मुनाफ़ा", meaning: "Sales minus cost, before expenses; never total or net profit." },
  margin: { en: "Margin", hinglish: "Margin", hi: "मार्जिन", meaning: "Profit as a share of the price; explain with help text." },

  // Returns and adjustments
  goodsReturn: { en: "Return", hinglish: "Wapsi", hi: "वापसी", meaning: "Goods coming back." },
  refund: { en: "Refund", hinglish: "Paisa wapas kiya", hi: "पैसा वापस किया", meaning: "Money returned to a customer; not a reversal." },
  creditNote: { en: "Credit note", hinglish: "Credit note", hi: "क्रेडिट नोट", meaning: "The document for a return; add help text." },
  reversedStatus: { en: "Reversed", hinglish: "Wapas li gayi", hi: "वापस ली गई", meaning: "The status of an entry that was undone; the transaction itself is a Reversal." },
  reversal: { en: "Reversal", hinglish: "Entry wapas li", hi: "एंट्री वापस ली", meaning: "Undoes a wrong entry; no money is returned to anyone by this word." },
  stockAdjustment: { en: "Stock adjustment", hinglish: "Stock sudhar", hi: "स्टॉक सुधार", meaning: "Corrects a stock count, with a reason." },
  billCorrection: { en: "Bill correction", hinglish: "Bill sudhar", hi: "बिल सुधार", meaning: "Corrects a bill." },

  // Reports, approvals and roles
  report: { en: "Report", hinglish: "Report", hi: "रिपोर्ट", meaning: "Totals for a chosen period." },
  approval: { en: "Approval", hinglish: "Approval", hi: "मंज़ूरी", meaning: "The owner's permission for a restricted action." },
  owner: { en: "Owner", hinglish: "Malik", hi: "मालिक", meaning: "Shop owner role." },
  notification: { en: "Notification", hinglish: "Alert", hi: "सूचना", meaning: "In-app message." },
} as const satisfies Record<string, GlossaryTerm>;
