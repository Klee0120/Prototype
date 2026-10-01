// External Smartsheet intake forms shared between the tech-facing and
// admin-facing views -- defined once so the two never drift apart if a
// form URL ever changes. "C&W PO" here means a C&W-internal purchase
// order -- a different thing entirely from the Toyota PO tracked on the
// WOM lifecycle checklist, and from a vendor's own PO.
export const WOM_REQUEST_FORM_URL = "https://app.smartsheet.com/b/form/93627e8bdd8740539499cf0141f1102c";
export const CW_PO_REQUEST_FORM_URL = "https://app.smartsheet.com/b/form/3794301abedd49c88adf271f96484776";

// Must match db.TERRITORIES on the server -- a location's territory,
// shown wherever locations are added/edited and filtered by.
export const TERRITORIES = ["Midwest", "HQ", "East", "West"];
