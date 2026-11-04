const db = require("../data/db");
const smartsheet = require("./smartsheet");

// The actual Smartsheet-fetch + column-resolution + sync work, shared
// between the admin-triggered "Sync WOMs" button (server/routes/admin.js)
// and the scheduled auto-sync (server/scheduler.js) -- same logic either
// way, just a different caller and a different name recorded as who ran it.
// Throws on failure (Smartsheet not connected, no "WOM #" column found, or
// the fetch itself failing) -- callers decide how to report that (an HTTP
// error response for the button, a console.error for the scheduler).
async function runSmartsheetSync({ actorId, actorName }) {
  if (!smartsheet.isConfigured()) {
    throw new Error("Smartsheet isn't connected yet -- set SMARTSHEET_API_TOKEN and SMARTSHEET_SHEET_ID");
  }
  const sheet = await smartsheet.fetchSimplifiedSheet();
  const womColumn = sheet.columns.includes("WOM #") ? "WOM #" : null;
  if (!womColumn) {
    throw new Error('Could not find a "WOM #" column in the connected sheet');
  }
  const columns = {
    wom: womColumn,
    estimate: smartsheet.findColumn(sheet.columns, ["estimate", "wom", "$"]),
    applied: smartsheet.findColumn(sheet.columns, ["applied", "wom", "$"]),
    description: smartsheet.findColumn(sheet.columns, ["project", "name"]),
    dateRequested: smartsheet.findColumn(sheet.columns, ["date", "requested"]),
    maximo: smartsheet.findColumn(sheet.columns, ["maximo"]),
    location: smartsheet.findColumn(sheet.columns, ["site", "location"]),
    // "subsid" (not "subsidiary") on purpose -- the real tracker's column
    // is misspelled "Subsidary Code" (missing the second "i"), and this
    // shorter root matches both the correct and the misspelled version.
    subsidiary: smartsheet.findColumn(sheet.columns, ["subsid", "code"]),
    // The itemized estimate/applied breakdown, mirroring the aggregate
    // estimate/applied columns above but per category -- lets Cost
    // Analysis tell "labor overcharged" apart from "contracted services
    // increased" instead of only knowing the project total moved. Any of
    // these can be null if the connected sheet doesn't have that column
    // (an older sheet, or one that's never itemized this way); the fields
    // they'd feed just stay unset rather than the sync failing.
    // No "$" requirement on either side -- the real tracker is
    // inconsistent about it ("Estimate Labor $" has one, "Applied Labor"
    // doesn't), and "estimate"/"applied" + "labor" alone is specific
    // enough with nothing else on the sheet containing "labor" at all.
    estimatedLabor: smartsheet.findColumn(sheet.columns, ["estimate", "labor"]),
    // "Contracted Services" and "PO" are both names real sheets have used
    // for the same vendor-contracted dollar figure -- see findAnyColumn.
    estimatedContracted: smartsheet.findAnyColumn(sheet.columns, [
      ["estimate", "contracted", "$"],
      ["estimate", "po", "$"],
    ]),
    appliedLabor: smartsheet.findColumn(sheet.columns, ["applied", "labor"]),
    appliedContracted: smartsheet.findAnyColumn(sheet.columns, [
      ["applied", "contracted", "$"],
      ["applied", "po", "$"],
    ]),
    estimatedMaterials: smartsheet.findColumn(sheet.columns, ["estimate", "materials"]),
    appliedMaterials: smartsheet.findColumn(sheet.columns, ["applied", "materials"]),
    estimatedOtherDirect: smartsheet.findColumn(sheet.columns, ["estimate", "other", "direct"]),
    appliedOtherDirect: smartsheet.findColumn(sheet.columns, ["applied", "other", "direct"]),
    estimatedTax: smartsheet.findColumn(sheet.columns, ["estimate", "tax"]),
    appliedTax: smartsheet.findColumn(sheet.columns, ["applied", "tax"]),
    estimatedContingency: smartsheet.findColumn(sheet.columns, ["estimate", "contingency"]),
    // No "applied" (or any other) word of its own on the real tracker --
    // just "Contingency $" -- so this excludes the estimate-side column
    // instead of matching on a keyword the applied column doesn't have.
    appliedContingency: smartsheet.findColumn(sheet.columns, ["contingency"], ["estimate", "estimated"]),
    // The actual dollar amount on the real Toyota-approved PO ("TOY
    // Value" in the tracker) -- distinct from the estimate/applied
    // figures above, which are this app's own numbers, not Toyota's.
    toyotaPoValue: smartsheet.findColumn(sheet.columns, ["toy", "value"]),
    // "vendor" alone isn't specific enough -- the real tracker also has
    // "Vendor Invoice #" sitting earlier in column order than the actual
    // name/phone column, and findColumn returns the first match. "name"
    // narrows it to the one column that's actually "Vendor(s) Name/#/Phone"
    // without also matching "Vendor Invoice #"/"Vendor Onboard Issue"/
    // "Vendor INV Attached".
    vendor: smartsheet.findColumn(sheet.columns, ["vendor", "name"]),
    // Verbatim sheet fields surfaced on the WOM profile's Overview tab so
    // the tracker's own account of completion/invoicing is visible instead
    // of only ever landing inside the opaque smartsheet_raw_data blob --
    // never fed into this app's own `status` (see
    // computeWomStatusConflict in routes/woms.js and the woms.status
    // migration comment in db.js for why).
    sourceStatus: smartsheet.findAnyColumn(sheet.columns, [["wom", "status"], ["status"]]),
    // Excludes "date" so this never also matches "Work Completed Date"
    // below -- both contain "work" and "completed", and findColumn has no
    // way to prefer the shorter/more-specific title on its own.
    sourceWorkCompleted: smartsheet.findColumn(sheet.columns, ["work", "completed"], ["date"]),
    sourceBilling: smartsheet.findAnyColumn(sheet.columns, [["invoice", "status"], ["billing"], ["wom", "invoiced"]]),
    sourceRequestedBy: smartsheet.findAnyColumn(sheet.columns, [["requested", "by"], ["technician"]]),
    // Real invoicing evidence, pulled straight onto the WOM (see
    // db.applyWomSourceEvidence) -- never inferred from Status/Billing free
    // text. The real tracker's column is "C&W Invoice" (the actual invoice
    // number C&W issued), not "Invoice #" -- "c&w" is specific enough on its
    // own to not also match "Invoice Attached"/"Vendor INV Attached" below.
    invoiceNumber: smartsheet.findColumn(sheet.columns, ["c&w", "invoice"]),
    batchNumber: smartsheet.findColumn(sheet.columns, ["batch", "#"]),
    // A verbatim reference # (e.g. a RITM#) Krista enters by hand once a
    // batch is billed -- display-only, not evidence by itself.
    billingRefNumber: smartsheet.findColumn(sheet.columns, ["billing", "ref"]),
    // The billing checklist -- granular sub-steps on the way to an invoice
    // actually going out, shown on the WOM for visibility but never used by
    // themselves to flip `status` (only a real invoice # does that, or the
    // full checklist including this one completing -- see
    // sourceImpliesInvoiced). "Billing" alone, excluding "ref" so this
    // doesn't also match "Billing Ref #" above.
    vendorInvAttached: smartsheet.findColumn(sheet.columns, ["vendor", "inv", "attached"]),
    invoiceAttached: smartsheet.findColumn(sheet.columns, ["invoice", "attached"]),
    journalEdit: smartsheet.findColumn(sheet.columns, ["journal", "edit"]),
    aribaConfirm: smartsheet.findColumn(sheet.columns, ["ariba", "confirm"]),
    sentToJason: smartsheet.findColumn(sheet.columns, ["sent", "jason"]),
    // No column of its own -- "I emailed billing to confirm the batch
    // posted" is Krista's own manual step, not something the tracker
    // records. Billing Ref # (above) is the evidence that step happened
    // (she only has a ref # once billing's confirmed it back to her), so
    // syncWomsFromSheetRows derives this straight from billingRefNumber
    // rather than looking for a dedicated sheet column.
    // Dates shown alongside the Billing progress card -- when work actually
    // wrapped and when the batch posted, not just whether they did.
    workCompletedDate: smartsheet.findColumn(sheet.columns, ["work", "completed", "date"]),
    batchDate: smartsheet.findColumn(sheet.columns, ["batch", "date"]),
    // The tracker's own reclass note, kept to the one field that's
    // actually populated with any consistency (see db.syncWomsFromSheetRows
    // for why "Reclass to" is kept verbatim rather than parsed into an
    // enum -- "RECLASS WOM #"/"RECLASS GMP"/"Reclass Confirmed in GL" are
    // all essentially unused on the real tracker, so they're left alone).
    reclassAmountRequested: smartsheet.findColumn(sheet.columns, ["reclass", "amount"]),
    reclassSubmitted: smartsheet.findColumn(sheet.columns, ["reclass", "submitted"]),
    reclassToRaw: smartsheet.findColumn(sheet.columns, ["reclass", "to"]),
    // The Toyota PO document's own number and the Toyota contact tied to
    // it -- distinct from toyotaPoValue above, which is just the dollar
    // amount ("TOY Value"). "toyota"+"po" is specific enough on its own:
    // the real tracker's other PO-ish columns ("TOY PO Final", "PO #",
    // "C&W PO #") never contain the full word "Toyota".
    toyotaPoNumber: smartsheet.findColumn(sheet.columns, ["toyota", "po"]),
    toyotaRep: smartsheet.findColumn(sheet.columns, ["toyota", "rep"]),
  };
  // Snapshot every task's status before the sync so the diff afterward
  // can say how many of the resulting task-engine writes were this sync's
  // doing -- syncWomsFromSheetRows itself only reports WOM row outcomes.
  const beforeTasks = new Map(db.listTasks({}).map((t) => [t.id, { status: t.status, isException: Boolean(t.is_exception) }]));
  const result = db.syncWomsFromSheetRows(sheet.rows, columns);
  let tasksCreated = 0;
  let tasksCompleted = 0;
  let exceptionsFlagged = 0;
  for (const t of db.listTasks({})) {
    const before = beforeTasks.get(t.id);
    if (!before) tasksCreated++;
    else if (before.status !== "completed" && t.status === "completed") tasksCompleted++;
    if (t.is_exception && (!before || !before.isException)) exceptionsFlagged++;
  }

  const lastSync = db.recordSyncLog({
    syncedBy: actorId,
    womsCreated: result.created,
    womsPromoted: result.promoted,
    womsUpdated: result.updated,
    tasksCreated,
    tasksCompleted,
    exceptionsFlagged,
    totalRows: result.total,
    changedWoms: result.changedWoms,
  });

  db.addAudit(
    actorId,
    "SMARTSHEET_WOMS_SYNCED",
    `${actorName} synced WOMs from Smartsheet (${result.created} created, ${result.promoted} promoted from pending, ${result.updated} updated, ${tasksCreated} tasks created, ${tasksCompleted} tasks completed, ${exceptionsFlagged} workflow exceptions)`
  );

  return {
    ...result,
    tasksCreated,
    tasksCompleted,
    exceptionsFlagged,
    lastSync,
    womColumn: columns.wom,
    estimateColumn: columns.estimate,
    appliedColumn: columns.applied,
    descriptionColumn: columns.description,
    dateRequestedColumn: columns.dateRequested,
    maximoColumn: columns.maximo,
    locationColumn: columns.location,
    subsidiaryColumn: columns.subsidiary,
    estimatedLaborColumn: columns.estimatedLabor,
    estimatedContractedColumn: columns.estimatedContracted,
    appliedLaborColumn: columns.appliedLabor,
    appliedContractedColumn: columns.appliedContracted,
    estimatedMaterialsColumn: columns.estimatedMaterials,
    appliedMaterialsColumn: columns.appliedMaterials,
    estimatedOtherDirectColumn: columns.estimatedOtherDirect,
    appliedOtherDirectColumn: columns.appliedOtherDirect,
    estimatedTaxColumn: columns.estimatedTax,
    appliedTaxColumn: columns.appliedTax,
    estimatedContingencyColumn: columns.estimatedContingency,
    appliedContingencyColumn: columns.appliedContingency,
    toyotaPoValueColumn: columns.toyotaPoValue,
    vendorColumn: columns.vendor,
    sourceStatusColumn: columns.sourceStatus,
    sourceWorkCompletedColumn: columns.sourceWorkCompleted,
    sourceBillingColumn: columns.sourceBilling,
    sourceRequestedByColumn: columns.sourceRequestedBy,
    invoiceNumberColumn: columns.invoiceNumber,
    batchNumberColumn: columns.batchNumber,
    billingRefNumberColumn: columns.billingRefNumber,
    vendorInvAttachedColumn: columns.vendorInvAttached,
    invoiceAttachedColumn: columns.invoiceAttached,
    journalEditColumn: columns.journalEdit,
    aribaConfirmColumn: columns.aribaConfirm,
    sentToJasonColumn: columns.sentToJason,
    workCompletedDateColumn: columns.workCompletedDate,
    batchDateColumn: columns.batchDate,
    reclassAmountRequestedColumn: columns.reclassAmountRequested,
    reclassSubmittedColumn: columns.reclassSubmitted,
    reclassToColumn: columns.reclassToRaw,
  };
}

module.exports = { runSmartsheetSync };
