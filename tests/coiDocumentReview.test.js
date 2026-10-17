const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const { DatabaseSync } = require("node:sqlite");
const { extractCoiStructuredFields } = require("../server/utils/coiDocumentReview");

const REQUIRED_COI_LANGUAGE =
  "C&W Facility Services Inc. d/b/a C&W Services, Toyota Motor Sales, USA, Inc., its subsidiaries and affiliated corporations are additional insureds (except Workers’ Compensation) as required by written contract/agreement.";

// A real, minimal digitally-generated PDF with a genuine text layer --
// what a real ACORD 25 generated or typed into digitally would look like,
// as opposed to a scanned image with no extractable text at all.
async function buildFakePdf(lines) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 740;
  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 10, font, maxWidth: 530 });
    y -= 16;
  }
  return Buffer.from(await doc.save());
}

test("coi document review: a digitally-generated PDF extracts real text and the right hints", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", {
    userId: "ADMIN",
    body: { name: "Print Shop Co", email: "ops@printshop.test", services: "Corporate Administrative / Marketing & Communications / Commercial Printing & Finishing" },
  });
  const vendor = vendorRes.body;

  const pdfBytes = await buildFakePdf(["CERTIFICATE OF LIABILITY INSURANCE", "ACORD 25 (2016/03)", REQUIRED_COI_LANGUAGE]);
  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: pdfBytes,
    mimeType: "application/pdf",
  });

  const startRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" });
  assert.equal(startRes.status, 201);
  const review = startRes.body;
  assert.equal(review.status, "pending");
  assert.ok(review.extractedText.includes("ACORD 25"), "should have pulled real text off the digital PDF");
  assert.equal(review.extractionHints.acord25, true);
  assert.equal(review.extractionHints.language, true);

  // Universal items + GL OCC/GL AGG/WC for this vendor's one service (auto/
  // exs/eAndO/pol/crime/productsComplOpAgg are all "-" for this service, so
  // they're correctly left off).
  const keys = review.checklist.map((i) => i.key);
  assert.ok(keys.includes("acord25"));
  assert.ok(keys.includes("language"));
  assert.ok(keys.includes("certHolder"));
  assert.ok(keys.includes("autoLiabilityBoxes"));
  assert.ok(keys.some((k) => k.startsWith("glOcc:")));
  assert.ok(keys.some((k) => k.startsWith("glAgg:")));
  assert.ok(keys.some((k) => k.startsWith("wc:")));
  assert.ok(!keys.some((k) => k.startsWith("auto:")), "this service's auto requirement is '-' and shouldn't appear");

  // Re-starting a review on the same file while one is still pending
  // returns the same row, not a duplicate.
  const againRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" });
  assert.equal(againRes.status, 200);
  assert.equal(againRes.body.id, review.id);
});

test("coi document review: a non-extractable file still gets a review, just with no text", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Scanned Doc Co", email: "ops@scanneddoc.test" } });
  const vendor = vendorRes.body;

  // Not a real PDF at all -- same real-world outcome as a flat scanned
  // image with no text layer: pdfjs can't pull anything out of it.
  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: "not actually a pdf, just a scanned image pretending to be one",
    mimeType: "application/pdf",
  });

  const startRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" });
  assert.equal(startRes.status, 201);
  assert.equal(startRes.body.extractedText, "");
  assert.deepEqual(startRes.body.extractionHints, {});
  // Still gets the universal checklist items even with no service on file.
  assert.ok(startRes.body.checklist.some((i) => i.key === "acord25"));
});

test("coi document review: approve creates a ServiceEdge task naming the vendor's real territory", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Territory Co", email: "ops@territoryco.test" } });
  const vendor = vendorRes.body;

  // getVendorTerritories reads territory straight off a vendor's own PO
  // history (pos.region) -- a real PO import is a whole pipeline of its
  // own with dedicated test coverage elsewhere, so a raw insert is the
  // direct way to put "this vendor has been invoiced in Midwest" on
  // record for this test, same shortcut vendorComplianceReminders.test.js
  // takes for backdating a timestamp.
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();
  raw
    .prepare(
      `INSERT INTO pos (composite_key, vendor_id, region, first_imported_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, 'Midwest', ?, ?, ?, ?)`
    )
    .run(`TERRITORY-TEST-${vendor.id}`, vendor.id, now, now, now, now);

  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: await buildFakePdf(["placeholder"]),
    mimeType: "application/pdf",
  });
  const review = (await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" })).body;

  const approveRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/approve`, { userId: "ADMIN" });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.body.review.status, "approved");
  assert.ok(approveRes.body.review.reviewedByName);
  assert.ok(approveRes.body.task.description.includes("Midwest"), approveRes.body.task.description);
  // createTask (same as every other route calling it directly) returns the
  // raw DB row, snake_case columns included -- not run through a presenter.
  assert.equal(approveRes.body.task.related_vendor_id, vendor.id);

  // Approving is what drives the legacy vendor-level compliance flags now
  // -- no separate manual checkbox for this anymore (see
  // applyCoiReviewOutcomeToVendor in db.js).
  const approvedVendor = (await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" })).body.find((v) => v.id === vendor.id);
  assert.equal(approvedVendor.coiMeetsRequiredLimits, true);
  assert.equal(approvedVendor.coiMeetsLanguageRequirements, true);
  assert.equal(approvedVendor.formChecks.coiIsAcord25_2016_03, true);
  assert.equal(approvedVendor.formChecks.coiMatchesW9, true);

  // Can't approve (or reject) the same review twice.
  const reapproveRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/approve`, { userId: "ADMIN" });
  assert.equal(reapproveRes.status, 400);

  const audit = await server.call("GET", "/api/audit", { userId: "ADMIN" });
  assert.ok(audit.body.some((e) => e.action === "VENDOR_COI_REVIEW_APPROVED" && e.details.includes("Territory Co")));
});

test("coi document review: reject requires reasons from the review's own checklist, and emails the vendor", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Rejected Co", email: "ops@rejectedco.test" } });
  const vendor = vendorRes.body;

  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: await buildFakePdf(["placeholder"]),
    mimeType: "application/pdf",
  });
  const review = (await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" })).body;

  const noReasonsRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/reject`, { userId: "ADMIN", body: { reasonKeys: [] } });
  assert.equal(noReasonsRes.status, 400);

  const badReasonRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/reject`, {
    userId: "ADMIN",
    body: { reasonKeys: ["not-a-real-key"] },
  });
  assert.equal(badReasonRes.status, 400);

  const rejectRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/reject`, {
    userId: "ADMIN",
    body: { reasonKeys: ["acord25", "certHolder"] },
  });
  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.body.review.status, "rejected");
  assert.deepEqual(rejectRes.body.review.rejectedReasons, ["acord25", "certHolder"]);
  assert.equal(rejectRes.body.emailSkippedNoAddress, false);

  const audit = await server.call("GET", "/api/audit", { userId: "ADMIN" });
  const entry = audit.body.find((e) => e.action === "VENDOR_COI_REVIEW_REJECTED" && e.details.includes("Rejected Co"));
  assert.ok(entry);
  assert.match(entry.details, /ACORD 25/);
  assert.match(entry.details, /Certificate Holder/);

  // Only the two legacy flags implicated by the chosen reasons flip false
  // -- "Meets required limits"/"meets language" are untouched since
  // neither a limit key nor "language" was picked.
  const rejectedVendor = (await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" })).body.find((v) => v.id === vendor.id);
  assert.equal(rejectedVendor.formChecks.coiIsAcord25_2016_03, false);
  assert.equal(rejectedVendor.formChecks.coiMatchesW9, false);
  assert.equal(rejectedVendor.coiMeetsRequiredLimits, false, "defaults false, never set true for this vendor");
  assert.equal(rejectedVendor.coiMeetsLanguageRequirements, false, "defaults false, never set true for this vendor");
});

test("coi document review: rejecting a coverage-limit reason clears only coiMeetsRequiredLimits", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", {
    userId: "ADMIN",
    body: { name: "Limit Rejected Co", services: "Corporate Administrative / Marketing & Communications / Commercial Printing & Finishing" },
  });
  const vendor = vendorRes.body;

  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: await buildFakePdf(["placeholder"]),
    mimeType: "application/pdf",
  });
  const review = (await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" })).body;
  const glOccKey = review.checklist.find((i) => i.key.startsWith("glOcc:")).key;

  const rejectRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/reject`, {
    userId: "ADMIN",
    body: { reasonKeys: [glOccKey] },
  });
  assert.equal(rejectRes.status, 200);

  const rejectedVendor = (await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" })).body.find((v) => v.id === vendor.id);
  assert.equal(rejectedVendor.coiMeetsRequiredLimits, false);
  // Nothing else was implicated by this one reason.
  assert.equal(rejectedVendor.coiMeetsLanguageRequirements, false, "defaults false, never set true for this vendor");
  assert.equal(rejectedVendor.formChecks.coiIsAcord25_2016_03, false, "defaults false, never set true for this vendor");
});

test("coi document review: a technician can't start, approve, or reject a review", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Tech Blocked Co" } });
  const vendor = vendorRes.body;
  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: "x",
  });

  const res = await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "T1001" });
  assert.equal(res.status, 403);
});

test("extractCoiStructuredFields: pulls policy #, carrier, and expiration out of a flattened ACORD row, and stays empty with nothing to find", () => {
  const sample = [
    "ACORD CERTIFICATE OF LIABILITY INSURANCE",
    "INSURER(S) AFFORDING COVERAGE NAIC #",
    "INSURER A : Travelers Casualty and Surety Company 19038",
    "INSR LTR TYPE OF INSURANCE POLICY NUMBER POLICY EFF (MM/DD/YYYY) POLICY EXP (MM/DD/YYYY) LIMITS",
    "A GENERAL LIABILITY CL1234567890 01/01/2025 01/01/2026 EACH OCCURRENCE 1,000,000",
  ].join("\n");

  const fields = extractCoiStructuredFields(sample);
  assert.equal(fields.policyNumber, "CL1234567890");
  assert.equal(fields.carrier, "Travelers Casualty and Surety Company");
  assert.equal(fields.expirationDate, "2026-01-01");

  assert.deepEqual(extractCoiStructuredFields(""), { policyNumber: null, carrier: null, expirationDate: null });
  assert.deepEqual(extractCoiStructuredFields("a scanned image with no useful text"), {
    policyNumber: null,
    carrier: null,
    expirationDate: null,
  });
});

test("coi review -> case sync: approving creates the vendor's Onboarding - COI case, Approved, with the submitted policy details", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Case Sync Co" } });
  const vendor = vendorRes.body;

  // No case at all yet -- this is the vendor's first COI ever reviewed.
  const beforeRequests = (await server.call("GET", `/api/admin/vendors/${vendor.id}/requests`, { userId: "ADMIN" })).body;
  assert.equal(beforeRequests.length, 0);

  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: await buildFakePdf(["placeholder"]),
    mimeType: "application/pdf",
  });
  const review = (await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" })).body;

  const approveRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/approve`, {
    userId: "ADMIN",
    body: { policyNumber: "POL-998877", carrier: "Acme Mutual", expirationDate: "2027-03-15" },
  });
  assert.equal(approveRes.status, 200);

  const requests = (await server.call("GET", `/api/admin/vendors/${vendor.id}/requests`, { userId: "ADMIN" })).body;
  const coiCase = requests.find((r) => r.requestType === "Onboarding - COI");
  assert.ok(coiCase, "approving a COI review should create the vendor's Onboarding - COI case");
  assert.equal(coiCase.status, "Approved");
  assert.equal(coiCase.coiPolicyNumber, "POL-998877");
  assert.equal(coiCase.coiCarrier, "Acme Mutual");
  assert.equal(coiCase.expirationDate, "2027-03-15");
  assert.deepEqual(coiCase.reviewNotesSelected, []);

  // "Add to my vendor compliance list like the vendor onboard profile
  // does" -- the vendor's own onboarding stage should now reflect real
  // case activity instead of staying not_started.
  const synced = (await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" })).body.find((v) => v.id === vendor.id);
  assert.equal(synced.onboardingStage, "in_progress");
});

test("coi review -> case sync: rejecting sets Revisions needed and maps checklist reasons onto the case's own review-notes vocabulary", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Case Sync Reject Co" } });
  const vendor = vendorRes.body;
  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: await buildFakePdf(["placeholder"]),
    mimeType: "application/pdf",
  });
  const review = (await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" })).body;

  const rejectRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/reject`, {
    userId: "ADMIN",
    body: { reasonKeys: ["acord25", "certHolder"] },
  });
  assert.equal(rejectRes.status, 200);

  const requests = (await server.call("GET", `/api/admin/vendors/${vendor.id}/requests`, { userId: "ADMIN" })).body;
  const coiCase = requests.find((r) => r.requestType === "Onboarding - COI");
  assert.ok(coiCase);
  assert.equal(coiCase.status, "Revisions needed");
  assert.deepEqual(new Set(coiCase.reviewNotesSelected), new Set(["acord_25_form", "fix_holder_information"]));
});

test("coi review -> case sync: a second review updates the SAME case rather than creating a duplicate, and never blanks a previously-set reference number", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Case Sync Repeat Co" } });
  const vendor = vendorRes.body;

  // An admin had already logged this vendor's COI case by hand (e.g. the
  // ServiceEdge case number) before any document was ever reviewed here --
  // that reference number must survive the review-driven sync untouched.
  await server.call("POST", `/api/admin/vendors/${vendor.id}/requests`, {
    userId: "ADMIN",
    body: { requestType: "Onboarding - COI", referenceNumber: "SE-COI-555", status: "Case started" },
  });

  const upload1 = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi1.pdf",
    fileContent: await buildFakePdf(["placeholder"]),
    mimeType: "application/pdf",
  });
  const review1 = (await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload1.body.id}/coi-review`, { userId: "ADMIN" })).body;
  await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review1.id}/reject`, {
    userId: "ADMIN",
    body: { reasonKeys: ["acord25"], policyNumber: "POL-111" },
  });

  const afterFirst = (await server.call("GET", `/api/admin/vendors/${vendor.id}/requests`, { userId: "ADMIN" })).body;
  const coiCases1 = afterFirst.filter((r) => r.requestType === "Onboarding - COI");
  assert.equal(coiCases1.length, 1, "should update the existing case, not create a second one");
  assert.equal(coiCases1[0].referenceNumber, "SE-COI-555", "the admin's own reference number must not be wiped by the review sync");
  assert.equal(coiCases1[0].coiPolicyNumber, "POL-111");

  const upload2 = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi2.pdf",
    fileContent: await buildFakePdf(["placeholder"]),
    mimeType: "application/pdf",
  });
  const review2 = (await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload2.body.id}/coi-review`, { userId: "ADMIN" })).body;
  await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review2.id}/approve`, { userId: "ADMIN" });

  const afterSecond = (await server.call("GET", `/api/admin/vendors/${vendor.id}/requests`, { userId: "ADMIN" })).body;
  const coiCases2 = afterSecond.filter((r) => r.requestType === "Onboarding - COI");
  assert.equal(coiCases2.length, 1, "still just the one case, now approved");
  assert.equal(coiCases2[0].status, "Approved");
  assert.equal(coiCases2[0].referenceNumber, "SE-COI-555", "still preserved after a second sync with no policyNumber submitted");
  // The approve call didn't submit a policyNumber -- the previous
  // rejection's "POL-111" should still be on file, not blanked.
  assert.equal(coiCases2[0].coiPolicyNumber, "POL-111");
});
