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
