const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("vendors: onboarding/compliance tracker CRUD + authorization", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a technician cannot list vendors", async () => {
    const res = await server.call("GET", "/api/admin/vendors", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("admin sees an empty list before any vendors exist", async () => {
    const res = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  await t.test("a technician cannot create a vendor", async () => {
    const res = await server.call("POST", "/api/admin/vendors", {
      userId: "T1001",
      body: { name: "Hijack Vendor" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("name is required", async () => {
    const res = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: {} });
    assert.equal(res.status, 400);
  });

  await t.test("rejects an invalid status value", async () => {
    const res = await server.call("POST", "/api/admin/vendors", {
      userId: "ADMIN",
      body: { name: "Bad Status Co", cwStatus: "sort-of" },
    });
    assert.equal(res.status, 400);
  });

  let vendorId;
  await t.test("admin can create a vendor, defaulting unset statuses to unknown", async () => {
    const res = await server.call("POST", "/api/admin/vendors", {
      userId: "ADMIN",
      body: { name: "24/7 Fire Protection", jdeVendorNumber: "5865247", toyotaStatus: "approved" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, "24/7 Fire Protection");
    assert.equal(res.body.jdeVendorNumber, "5865247");
    assert.equal(res.body.toyotaStatus, "approved");
    assert.equal(res.body.cwStatus, "unknown");
    assert.equal(res.body.formsStatus, "unknown");
    vendorId = res.body.id;
  });

  await t.test("the new vendor shows up in the list", async () => {
    const res = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].id, vendorId);
  });

  await t.test("a technician cannot edit a vendor", async () => {
    const res = await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "T1001",
      body: { name: "Hijacked" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("admin can edit a vendor's status and detail fields", async () => {
    const res = await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "ADMIN",
      body: {
        name: "24/7 Fire Protection",
        cwStatus: "active",
        toyotaStatus: "approved",
        formsStatus: "outdated",
        phone: "(513) 555-0100",
        services: "Fire/Life Safety",
        successfulInvoiceRecords: 2,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.cwStatus, "active");
    assert.equal(res.body.formsStatus, "outdated");
    assert.equal(res.body.phone, "(513) 555-0100");
    assert.equal(res.body.services, "Fire/Life Safety");
    assert.equal(res.body.successfulInvoiceRecords, 2);
  });

  await t.test("a freshly created vendor's document checks default to incomplete", async () => {
    const res = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    const vendor = res.body.find((v) => v.id === vendorId);
    assert.equal(vendor.formChecksComplete, false);
    assert.equal(vendor.formChecks.coiIsAcord25_2016_03, false);
    assert.equal(vendor.w9InvoiceStale, false);
  });

  await t.test("checking every document box makes formChecksComplete true", async () => {
    const allChecked = {
      coiIsAcord25_2016_03: true,
      coiMatchesW9: true,
      w9SignedDated: true,
      w9CorrectVersion: true,
      w9HasPhone: true,
      w9HasRemitToAddress: true,
      w9HasName: true,
      achBankLetterhead: true,
      achHasW9Name: true,
      achHasW9Address: true,
    };
    const res = await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "ADMIN",
      body: { name: "24/7 Fire Protection", formChecks: allChecked },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.formChecksComplete, true);

    // Unchecking just one flips it back.
    const uncheckOne = await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "ADMIN",
      body: { name: "24/7 Fire Protection", formChecks: { ...allChecked, achHasW9Address: false } },
    });
    assert.equal(uncheckOne.body.formChecksComplete, false);
  });

  await t.test("a W-9 invoice date over 2 years old flags as stale", async () => {
    const fiveYearsAgo = new Date();
    fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
    const stale = await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "ADMIN",
      body: { name: "24/7 Fire Protection", w9InvoiceDate: fiveYearsAgo.toISOString().slice(0, 10) },
    });
    assert.equal(stale.status, 200);
    assert.equal(stale.body.w9InvoiceStale, true);

    const recent = new Date();
    recent.setMonth(recent.getMonth() - 3);
    const fresh = await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "ADMIN",
      body: { name: "24/7 Fire Protection", w9InvoiceDate: recent.toISOString().slice(0, 10) },
    });
    assert.equal(fresh.body.w9InvoiceStale, false);
  });

  await t.test("editing an unknown vendor 404s", async () => {
    const res = await server.call("PATCH", "/api/admin/vendors/999999", {
      userId: "ADMIN",
      body: { name: "Nope" },
    });
    assert.equal(res.status, 404);
  });

  await t.test("a technician cannot delete a vendor", async () => {
    const res = await server.call("DELETE", `/api/admin/vendors/${vendorId}`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("admin can delete a vendor", async () => {
    const res = await server.call("DELETE", `/api/admin/vendors/${vendorId}`, { userId: "ADMIN" });
    assert.equal(res.status, 200);

    const list = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.deepEqual(list.body, []);
  });

  await t.test("deleting an already-deleted vendor 404s", async () => {
    const res = await server.call("DELETE", `/api/admin/vendors/${vendorId}`, { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });

  await t.test("vendor create/update/delete are audited", async () => {
    const res = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const actions = res.body.map((e) => e.action);
    assert.ok(actions.includes("VENDOR_CREATED"));
    assert.ok(actions.includes("VENDOR_UPDATED"));
    assert.ok(actions.includes("VENDOR_DELETED"));
  });
});

test("vendors: onboarding tracker (stage, denied reason, case log)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  let vendorId;

  await t.test("a newly added vendor defaults to In Progress -- adding one here is starting to onboard it", async () => {
    const res = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Momentum Mechanical" } });
    assert.equal(res.status, 201);
    assert.equal(res.body.onboardingStage, "in_progress");
    assert.equal(res.body.deniedReason, "");
    vendorId = res.body.id;
  });

  await t.test("rejects an invalid onboarding stage", async () => {
    const res = await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "ADMIN",
      body: { name: "Momentum Mechanical", onboardingStage: "sort-of-onboarded" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("moving it to Denied with a reason doesn't touch its other fields", async () => {
    const res = await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "ADMIN",
      body: { name: "Momentum Mechanical", phone: "555-0100", onboardingStage: "denied", deniedReason: "ACH issue" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.onboardingStage, "denied");
    assert.equal(res.body.deniedReason, "ACH issue");
    assert.equal(res.body.phone, "555-0100");
  });

  await t.test("not sending onboardingStage on an unrelated edit leaves the stage alone", async () => {
    const res = await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "ADMIN",
      body: { name: "Momentum Mechanical", phone: "555-0199" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.onboardingStage, "denied");
    assert.equal(res.body.deniedReason, "ACH issue");
    assert.equal(res.body.phone, "555-0199");
  });

  await t.test("stage changes are audited distinctly from a plain update", async () => {
    const res = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const entry = res.body.find((e) => e.action === "VENDOR_ONBOARDING_STAGE_CHANGED");
    assert.ok(entry, "expected a VENDOR_ONBOARDING_STAGE_CHANGED audit entry");
    assert.match(entry.details, /ACH issue/);
  });

  await t.test("a technician cannot read a vendor's case log", async () => {
    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/requests`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("case log starts empty", async () => {
    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/requests`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  await t.test("logging a status update appears in the case log and bumps the vendor's own activity clock", async () => {
    const before = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    const beforeUpdatedAt = before.body.find((v) => v.id === vendorId).updatedAt;

    // Guarantee a measurable clock difference regardless of how fast the
    // two calls happen to run back to back.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/requests`, {
      userId: "ADMIN",
      body: { requestType: "Status Update", status: "Waiting on COI from vendor" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].status, "Waiting on COI from vendor");

    const after = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    const afterUpdatedAt = after.body.find((v) => v.id === vendorId).updatedAt;
    assert.ok(new Date(afterUpdatedAt) > new Date(beforeUpdatedAt), "expected updatedAt to advance after a case-log entry");
  });

  await t.test("updating a case log entry's status is reflected and re-audited as vendor activity", async () => {
    const list = await server.call("GET", `/api/admin/vendors/${vendorId}/requests`, { userId: "ADMIN" });
    const entryId = list.body[0].id;
    const res = await server.call("PATCH", `/api/admin/vendors/${vendorId}/requests/${entryId}`, {
      userId: "ADMIN",
      body: { requestType: "Status Update", status: "COI received -- reviewing" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body[0].status, "COI received -- reviewing");
  });
});

// ServiceEdge itself tracks onboarding as separate COI / W-9 / Payment
// Details cases, each independently approved or denied, and re-submitting
// after a denial opens a brand new case rather than editing the old one.
// onboardingStage mirrors that: it's derived from the latest case of each
// type, not set by hand, so it stays correct through exactly that
// deny-then-reopen-a-new-case pattern.
test("vendors: onboarding stage derives from COI/W-9/Payment case status", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const create = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Morley and Associates" } });
  const vendorId = create.body.id;

  await t.test("no cases yet -- defaults to In Progress from creation, not Not Started", async () => {
    assert.equal(create.body.onboardingStage, "in_progress");
  });

  async function logCase(requestType, status, referenceNumber) {
    return server.call("POST", `/api/admin/vendors/${vendorId}/requests`, {
      userId: "ADMIN",
      body: { requestType, status, referenceNumber },
    });
  }

  await t.test("one case approved, two still missing -- stays In Progress", async () => {
    const res = await logCase("Onboarding - COI", "Approved", "00801516");
    assert.equal(res.status, 201);
    const vendor = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.equal(vendor.body.find((v) => v.id === vendorId).onboardingStage, "in_progress");
  });

  await t.test("a case denied moves the vendor to Denied", async () => {
    await logCase("Onboarding - W8/W9", "Denied", "00801509b");
    const vendor = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.equal(vendor.body.find((v) => v.id === vendorId).onboardingStage, "denied");
  });

  await t.test("re-submitting opens a new case rather than editing the denied one, and approving it clears Denied", async () => {
    await logCase("Onboarding - W8/W9", "Approved", "00801509");
    const vendor = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    // COI and W-9 are approved, Payment hasn't had a case logged yet.
    assert.equal(vendor.body.find((v) => v.id === vendorId).onboardingStage, "in_progress");
  });

  await t.test("all three approved moves the vendor to Onboarded", async () => {
    await logCase("Onboarding - Payment Details", "Denied", "00801515");
    await logCase("Onboarding - Payment Details", "Approved", "00809233");
    const vendor = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.equal(vendor.body.find((v) => v.id === vendorId).onboardingStage, "onboarded");
  });

  await t.test("stage-changing case updates are audited", async () => {
    const res = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const entries = res.body.filter((e) => e.action === "VENDOR_ONBOARDING_STAGE_CHANGED" && e.details.includes("Morley"));
    assert.ok(entries.some((e) => e.details.includes("denied")), "expected an audit entry for moving to denied");
    assert.ok(entries.some((e) => e.details.includes("onboarded")), "expected an audit entry for moving to onboarded");
  });

  await t.test("bulk case-summary endpoint returns the latest case of each type", async () => {
    const res = await server.call("GET", "/api/admin/vendors/onboarding/case-summary", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.caseTypes.length, 4);
    const summary = res.body.summaries[vendorId];
    assert.equal(summary.coi.status, "Approved");
    assert.equal(summary.w9.status, "Approved");
    assert.equal(summary.payment.status, "Approved");
    assert.equal(summary.payment.referenceNumber, "00809233");
  });

  await t.test("a technician cannot read the bulk case-summary either", async () => {
    const res = await server.call("GET", "/api/admin/vendors/onboarding/case-summary", { userId: "T1001" });
    assert.equal(res.status, 403);
  });
});

// A case's status has to stay an exact match against "approved"/"denied"
// for deriveOnboardingStage to keep working -- so a reason like "missing
// Auto Liability language" needs its own column, not text appended onto
// status itself.
test("vendors: a case can carry a note without corrupting stage derivation", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const create = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Needs Adjustment Co" } });
  const vendorId = create.body.id;

  await t.test("logging a case with a note stores both separately", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/requests`, {
      userId: "ADMIN",
      body: { requestType: "Onboarding - COI", status: "Needs Adjustment", note: "Missing Auto Liability language" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body[0].status, "Needs Adjustment");
    assert.equal(res.body[0].note, "Missing Auto Liability language");
  });

  await t.test("a note doesn't move the vendor to Denied or Onboarded -- status alone still drives that", async () => {
    const vendor = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.equal(vendor.body.find((v) => v.id === vendorId).onboardingStage, "in_progress");
  });

  await t.test("updating a case entry can change the note independently of status", async () => {
    const list = await server.call("GET", `/api/admin/vendors/${vendorId}/requests`, { userId: "ADMIN" });
    const entryId = list.body[0].id;
    const res = await server.call("PATCH", `/api/admin/vendors/${vendorId}/requests/${entryId}`, {
      userId: "ADMIN",
      body: { requestType: "Onboarding - COI", status: "Approved", note: "Resubmitted with correct language" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body[0].status, "Approved");
    assert.equal(res.body[0].note, "Resubmitted with correct language");
  });

  await t.test("a case logged with no note at all defaults to an empty string, not null", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/requests`, {
      userId: "ADMIN",
      body: { requestType: "Onboarding - W8/W9", status: "New" },
    });
    assert.equal(res.body[0].note, "");
  });
});

test("vendors: a case's 'as of' date is a record-keeping field, separate from when it was logged, and editable", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const create = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "As Of Co" } });
  const vendorId = create.body.id;

  await t.test("an explicit asOf is stored as given, independent of when the entry was actually logged", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/requests`, {
      userId: "ADMIN",
      body: { requestType: "Onboarding - COI", status: "Needs Adjustment", note: "Missing E&O", asOf: "2026-09-15" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body[0].asOf, "2026-09-15");
  });

  await t.test("omitting asOf defaults to today, not null", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/requests`, {
      userId: "ADMIN",
      body: { requestType: "Onboarding - W8/W9", status: "New" },
    });
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(res.body[0].asOf, today);
  });

  await t.test("editing an entry in place (PATCH) can correct its asOf date without creating a new log row", async () => {
    const before = await server.call("GET", `/api/admin/vendors/${vendorId}/requests`, { userId: "ADMIN" });
    const coiEntry = before.body.find((e) => e.requestType === "Onboarding - COI");
    const countBefore = before.body.length;

    const res = await server.call("PATCH", `/api/admin/vendors/${vendorId}/requests/${coiEntry.id}`, {
      userId: "ADMIN",
      body: { requestType: "Onboarding - COI", status: "Needs Adjustment", note: "Missing E&O", asOf: "2026-09-20" },
    });
    assert.equal(res.status, 200);
    const updated = res.body.find((e) => e.id === coiEntry.id);
    assert.equal(updated.asOf, "2026-09-20", "the corrected date should be stored, not the original or today's date");
    assert.equal(res.body.length, countBefore, "editing in place must not add a new row");
  });

  await t.test("the bulk case-summary endpoint (the Onboarding board's data source) also carries asOf", async () => {
    const res = await server.call("GET", "/api/admin/vendors/onboarding/case-summary", { userId: "ADMIN" });
    assert.equal(res.body.summaries[vendorId].coi.asOf, "2026-09-20");
  });
});

test("vendors: compliance follow-up task is generated/closed automatically", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const create = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Arbon Equipment" } });
  const vendorId = create.body.id;

  // This vendor was created by ADMIN with no PO/WOM matched to it yet, so
  // findAdminForVendor (db.js) routes its compliance task to ADMIN directly
  // (assignedRole: "admin") rather than the old untargeted "financial"
  // role bucket -- hence role=admin here, not role=financial.
  async function findComplianceTask() {
    const tasks = await server.call("GET", "/api/tasks?view=team&role=admin&category=vendor_compliance", { userId: "ADMIN" });
    return tasks.body.find((t2) => t2.relatedVendorId === vendorId);
  }

  await t.test("a freshly created vendor (incomplete doc checks by default) gets a compliance follow-up task", async () => {
    // Reading the task board is what catches this up, same as WOM lifecycle tasks.
    await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const task = await findComplianceTask();
    assert.ok(task, "expected a vendor_compliance task for this new, not-yet-compliant vendor");
    assert.equal(task.priority, "normal");
    assert.ok(task.description.includes("document checks"));
  });

  await t.test("it can be snoozed like any other task", async () => {
    const task = await findComplianceTask();
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    const res = await server.call("POST", `/api/tasks/${task.id}/reschedule`, {
      userId: "ADMIN",
      body: { snoozedUntil: tomorrow, note: "Waiting on vendor to send updated COI." },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.snoozedUntil);
    // Un-snooze again so later assertions in this test aren't chasing a
    // task that's filtered out of the default views by its own snooze.
    await server.call("POST", `/api/tasks/${task.id}/unsnooze`, { userId: "ADMIN" });
  });

  await t.test("fixing every compliance gap auto-closes the task", async () => {
    const allChecked = {
      coiIsAcord25_2016_03: true,
      coiMatchesW9: true,
      w9SignedDated: true,
      w9CorrectVersion: true,
      w9HasPhone: true,
      w9HasRemitToAddress: true,
      w9HasName: true,
      achBankLetterhead: true,
      achHasW9Name: true,
      achHasW9Address: true,
    };
    await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "ADMIN",
      body: { name: "Arbon Equipment", formChecks: allChecked, formsStatus: "current" },
    });
    await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const taskList = await server.call("GET", "/api/tasks?view=team&category=vendor_compliance&status=completed", { userId: "ADMIN" });
    const task = taskList.body.find((t2) => t2.relatedVendorId === vendorId);
    assert.ok(task, "expected the completed compliance task to show up under status=completed");
    assert.equal(task.status, "completed", "expected the task to auto-complete once every gap is closed");
  });

  await t.test("an expired COI upload alone (even with checks/forms otherwise fine) reopens it", async () => {
    await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor", relatedId: String(vendorId), category: "coi", expiresAt: "2020-01-01" },
      fileName: "coi.pdf",
    });
    await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const taskList = await server.call("GET", "/api/tasks?view=team&category=vendor_compliance", { userId: "ADMIN" });
    const task = taskList.body.find((t2) => t2.relatedVendorId === vendorId);
    assert.equal(task.status, "open", "expected an expired COI document to reopen the compliance task");
    assert.ok(task.description.includes("expired"));
  });

  await t.test("a comment logged on it is visible from the vendor's own compliance-tasks endpoint", async () => {
    const taskList = await server.call("GET", "/api/tasks?view=team&category=vendor_compliance", { userId: "ADMIN" });
    const task = taskList.body.find((t2) => t2.relatedVendorId === vendorId);
    await server.call("POST", `/api/tasks/${task.id}/comments`, { userId: "ADMIN", body: { body: "Called vendor, new COI coming Friday." } });

    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/compliance-tasks`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 1);
    const found = res.body.find((t2) => t2.id === task.id);
    assert.ok(found.comments.some((c) => c.body === "Called vendor, new COI coming Friday."));
  });

  await t.test("a technician cannot see a vendor's compliance tasks", async () => {
    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/compliance-tasks`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("compliance tasks for an unknown vendor 404", async () => {
    const res = await server.call("GET", "/api/admin/vendors/999999/compliance-tasks", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });
});

test("vendors: territory-derived compliance routing (findAdminForVendor)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const db = require("../server/data/db");
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);

  db.createLocation("EASTLOC", "East Test Site", null, "East", null, "East", null);
  await server.call("POST", "/api/admin/admins", {
    userId: "ADMIN",
    body: { id: "ADMIN-EAST", name: "East Admin", pin: "5555", homeLocationCode: "EASTLOC" },
  });

  function insertMatchedPo(vendorId, region) {
    const now = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO pos (composite_key, vendor_id, region, po_amount, lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, 1000, 'active', ?, ?, ?, ?)`
      )
      .run(`TEST-PO-${vendorId}-${region}`, vendorId, region, now, now, now, now);
  }

  await t.test("a vendor matched to a PO in a territory routes its compliance task to that territory's admin", async () => {
    const create = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "East Fixtures Co" } });
    const vendorId = create.body.id;
    insertMatchedPo(vendorId, "East");

    const tasks = await server.call("GET", "/api/tasks?view=team&role=admin&category=vendor_compliance", { userId: "ADMIN" });
    const task = tasks.body.find((t2) => t2.relatedVendorId === vendorId);
    assert.ok(task, "expected a compliance task routed to an admin");
    assert.equal(task.assignedTo, "ADMIN-EAST", "expected it routed to the admin whose home territory matches the vendor's own");
  });

  await t.test("the vendor's own territories (derived) show up in the API response", async () => {
    const create = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Midwest Fixtures Co" } });
    const vendorId = create.body.id;
    insertMatchedPo(vendorId, "Midwest");

    const res = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    const vendor = res.body.find((v) => v.id === vendorId);
    assert.deepEqual(vendor.territories, ["Midwest"]);
  });

  await t.test("a vendor matched in two territories returns both", async () => {
    const create = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Multi-Territory Co" } });
    const vendorId = create.body.id;
    insertMatchedPo(vendorId, "Midwest");
    insertMatchedPo(vendorId, "East");

    const res = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    const vendor = res.body.find((v) => v.id === vendorId);
    assert.deepEqual(vendor.territories, ["East", "Midwest"]);
  });

  await t.test("a freshly created vendor with no PO/WOM match yet has no derived territory and is attributed to its creator", async () => {
    const create = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Brand New Co" } });
    const vendorId = create.body.id;

    const res = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    const vendor = res.body.find((v) => v.id === vendorId);
    assert.deepEqual(vendor.territories, []);
    assert.equal(vendor.createdBy, "ADMIN");
  });
});

test("vendors: explicit denial (cost/service, not just a document case) + reinstate", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  let vendorId;

  await t.test("the reason list is available", async () => {
    const res = await server.call("GET", "/api/admin/vendors/denial-reasons", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const keys = res.body.map((r) => r.key);
    assert.deepEqual(keys, ["insurance", "document_chasing", "unacceptable_service", "cost", "other"]);
  });

  await t.test("set up a vendor with all three cases approved (fully onboarded)", async () => {
    const res = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Overpriced Overhead Doors" } });
    vendorId = res.body.id;
    for (const requestType of ["Onboarding - COI", "Onboarding - W8/W9", "Onboarding - Payment Details"]) {
      await server.call("POST", `/api/admin/vendors/${vendorId}/requests`, { userId: "ADMIN", body: { requestType, status: "Approved" } });
    }
    const vendor = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.equal(vendor.body.find((v) => v.id === vendorId).onboardingStage, "onboarded");
  });

  await t.test("a technician cannot deny a vendor", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/deny`, { userId: "T1001", body: { category: "cost" } });
    assert.equal(res.status, 403);
  });

  await t.test("rejects an unknown reason category", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/deny`, { userId: "ADMIN", body: { category: "too_slow" } });
    assert.equal(res.status, 400);
  });

  await t.test("admin can deny an otherwise fully-onboarded vendor for cost -- no case captures that", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/deny`, {
      userId: "ADMIN",
      body: { category: "cost", reason: "Quoted 2x the next vendor for the same scope" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.onboardingStage, "denied");
    assert.equal(res.body.deniedReasonCategory, "cost");
    assert.equal(res.body.deniedReason, "Quoted 2x the next vendor for the same scope");
  });

  await t.test("the denial is audited with its reason label", async () => {
    const res = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const entry = res.body.find((e) => e.action === "VENDOR_ONBOARDING_STAGE_CHANGED" && /Cost/.test(e.details));
    assert.ok(entry, "expected an audit entry naming the Cost reason");
  });

  await t.test("logging an unrelated case afterward does not silently clear the manual denial", async () => {
    await server.call("POST", `/api/admin/vendors/${vendorId}/requests`, {
      userId: "ADMIN",
      body: { requestType: "Onboarding - COI", status: "Approved", note: "Renewed COI on file" },
    });
    const vendor = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.equal(vendor.body.find((v) => v.id === vendorId).onboardingStage, "denied");
  });

  await t.test("a technician cannot reinstate a vendor", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/reinstate`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("reinstating clears the manual denial and recomputes from actual case history", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/reinstate`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.deniedReasonCategory, "");
    assert.equal(res.body.deniedReason, "");
    // All three cases are still approved (W-9/Payment from setup, COI re-approved above).
    assert.equal(res.body.onboardingStage, "onboarded");
  });

  await t.test("denying and reinstating an unknown vendor 404s", async () => {
    const denyRes = await server.call("POST", "/api/admin/vendors/999999/deny", { userId: "ADMIN", body: { category: "cost" } });
    assert.equal(denyRes.status, 404);
    const reinstateRes = await server.call("POST", "/api/admin/vendors/999999/reinstate", { userId: "ADMIN" });
    assert.equal(reinstateRes.status, 404);
  });
});

test("vendors: notify vendor of an expired COI/W-9/ACH document", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  let vendorId;

  await t.test("set up a vendor with no documents on file", async () => {
    const res = await server.call("POST", "/api/admin/vendors", {
      userId: "ADMIN",
      body: { name: "Expiring Docs Co", email: "ops@expiringdocs.test" },
    });
    vendorId = res.body.id;
  });

  await t.test("a technician cannot trigger the notification", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/notify-expired-docs`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("nothing expired yet -- rejected", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/notify-expired-docs`, { userId: "ADMIN" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /no expired/i);
  });

  await t.test("after a COI expires, it's listed and the vendor's list shows it too", async () => {
    await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor", relatedId: String(vendorId), category: "coi", expiresAt: "2020-01-01" },
      fileName: "coi.pdf",
    });
    const list = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    const v = list.body.find((v2) => v2.id === vendorId);
    assert.deepEqual(v.expiredComplianceCategories, ["coi"]);

    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/notify-expired-docs`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.categories, ["coi"]);
    // No SMTP configured in tests -- the route still succeeds, just reports it wasn't actually delivered.
    assert.equal(res.body.sent, false);
  });

  await t.test("the notification is audited", async () => {
    const audit = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const entry = audit.body.find((e) => e.action === "VENDOR_NOTIFIED_EXPIRED_DOCS");
    assert.ok(entry);
    assert.match(entry.details, /Expiring Docs Co/);
    assert.match(entry.details, /Certificate of Insurance/);
  });

  await t.test("a vendor with no email on file is rejected", async () => {
    const noEmail = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "No Email Co" } });
    await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor", relatedId: String(noEmail.body.id), category: "w9", expiresAt: "2020-01-01" },
      fileName: "w9.pdf",
    });
    const res = await server.call("POST", `/api/admin/vendors/${noEmail.body.id}/notify-expired-docs`, { userId: "ADMIN" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /no email/i);
  });

  await t.test("an unknown vendor 404s", async () => {
    const res = await server.call("POST", "/api/admin/vendors/999999/notify-expired-docs", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });
});

// The Work & Costs tab's "PO Open vs. GL Applied" rollup -- same
// never-double-count remaining calculation as Spend Analysis's own
// "current estimated PO" checkbox, just grouped by vendor instead of
// category/territory. See db.getVendorPoGlRollup.
test("vendors: PO-open vs. GL-applied rollup", async (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Rollup Test Vendor" } });
  const vendorId = vendorRes.body.id;

  function insertPo({ composite, poNumber, poAmount, lifecycleStatus }) {
    const result = raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, po_amount, vendor_id, lifecycle_status,
         first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(composite, poNumber, poAmount, vendorId, lifecycleStatus || "active", now, now, now, now);
    return Number(result.lastInsertRowid);
  }

  await t.test("a vendor with no POs on file gets an all-zero rollup", async () => {
    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/po-gl-rollup`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { poOpenTotal: 0, poOpenCount: 0, glAppliedTotal: 0, glAppliedPoCount: 0 });
  });

  await t.test("a PO with no GL activity counts entirely as open, nothing applied", async () => {
    const poId = insertPo({ composite: "roll-1", poNumber: "PO97001", poAmount: 400 });

    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/po-gl-rollup`, { userId: "ADMIN" });
    assert.equal(res.body.poOpenTotal, 400);
    assert.equal(res.body.poOpenCount, 1);
    assert.equal(res.body.glAppliedTotal, 0);
    assert.equal(res.body.glAppliedPoCount, 0);

    raw.prepare("DELETE FROM pos WHERE id = ?").run(poId);
  });

  await t.test("a partially-matched PO splits between open and applied, never double-counted", async () => {
    const poId = insertPo({ composite: "roll-2", poNumber: "PO97002", poAmount: 1000 });
    db.importGlEntries([{ glDate: "2026-09-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 350, purchaseOrder: "PO97002" }], 18, 26, "ADMIN", "t-rollup.xlsx");
    raw.prepare("UPDATE gl_entries SET matched_po_id = ? WHERE purchase_order = 'PO97002'").run(poId);

    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/po-gl-rollup`, { userId: "ADMIN" });
    assert.equal(res.body.poOpenTotal, 650, "1000 - 350 already applied = 650 still open");
    assert.equal(res.body.glAppliedTotal, 350);
    assert.equal(res.body.glAppliedPoCount, 1);

    raw.prepare("DELETE FROM pos WHERE id = ?").run(poId);
    raw.prepare("DELETE FROM gl_entries WHERE purchase_order = 'PO97002'").run();
  });

  await t.test("a needs_organization PO's GL activity still counts as applied, but it contributes no open amount", async () => {
    const poId = insertPo({ composite: "roll-3", poNumber: "PO97003", poAmount: 500, lifecycleStatus: "needs_organization" });
    db.importGlEntries([{ glDate: "2026-09-02", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 200, purchaseOrder: "PO97003" }], 18, 26, "ADMIN", "t-rollup2.xlsx");
    raw.prepare("UPDATE gl_entries SET matched_po_id = ? WHERE purchase_order = 'PO97003'").run(poId);

    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/po-gl-rollup`, { userId: "ADMIN" });
    assert.equal(res.body.poOpenTotal, 0, "a needs_organization PO never contributes to PO Open");
    assert.equal(res.body.glAppliedTotal, 200, "a real GL posting still counts even if the PO itself isn't Active");

    raw.prepare("DELETE FROM pos WHERE id = ?").run(poId);
    raw.prepare("DELETE FROM gl_entries WHERE purchase_order = 'PO97003'").run();
  });

  await t.test("a technician can't reach the rollup route", async () => {
    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/po-gl-rollup`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("an unknown vendor 404s", async () => {
    const res = await server.call("GET", "/api/admin/vendors/999999/po-gl-rollup", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });

  raw.close();
});
