const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// Vendor-portal requests never go through server.call's own authHeaders
// (built only for x-session-token) -- a small raw-fetch helper instead,
// so the test exercises the exact header a real vendor browser would
// send (x-vendor-session-token), not a stand-in.
async function vendorCall(server, method, urlPath, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["x-vendor-session-token"] = token;
  const res = await fetch(server.baseUrl + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

// Each test file runs its subtests against one shared db (see helpers.js),
// so a fixed Tax ID across tests would collide with the duplicate-Tax-ID
// check added alongside this feature -- unique per call instead, the same
// reasoning server.call's own vendor-creation helpers elsewhere give each
// vendor a distinct name/email.
let vendorCounter = 0;
// Mirrors helpers.js's own server.upload, just with the vendor-portal
// header instead of x-session-token -- same reasoning as vendorCall above.
async function vendorUpload(server, urlPath, { token, fields = {}, fileName = "test.txt", fileContent = "test content", mimeType = "text/plain" } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", new Blob([fileContent], { type: mimeType }), fileName);
  const headers = {};
  if (token) headers["x-vendor-session-token"] = token;
  const res = await fetch(server.baseUrl + urlPath, { method: "POST", headers, body: form });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

async function createVendorWithPortalAccess(server, overrides = {}) {
  vendorCounter += 1;
  const vendorRes = await server.call("POST", "/api/admin/vendors", {
    userId: "ADMIN",
    body: { name: `Portal Test Co ${vendorCounter}`, email: `ops${vendorCounter}@portaltest.test`, taxId: `12-345600${vendorCounter}`, ...overrides },
  });
  assert.equal(vendorRes.status, 201, JSON.stringify(vendorRes.body));
  const vendor = vendorRes.body;
  const credRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/portal-credential`, { userId: "ADMIN", body: {} });
  assert.equal(credRes.status, 200, JSON.stringify(credRes.body));
  return { vendor, taxId: credRes.body.taxId, passcode: credRes.body.passcode };
}

test("Vendor portal: login succeeds with the real Tax ID + passcode and returns a session token", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const res = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.token);
  assert.equal(res.body.name, vendor.name);
});

test("Vendor portal: wrong passcode is rejected, and five failures lock the Tax ID out", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { taxId } = await createVendorWithPortalAccess(server);

  for (let i = 0; i < 5; i++) {
    const res = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode: "wrong-passcode" } });
    assert.equal(res.status, 401, `attempt ${i + 1} should be a plain 401`);
  }
  const lockedRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode: "wrong-passcode" } });
  assert.equal(lockedRes.status, 429, "the 6th attempt should be locked out, even if this one happened to guess right");
});

test("Vendor portal: /me returns the same approved/total checklist math the admin board computes", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  // One real case, approved, so the portal's own math has something
  // non-zero to agree with the admin side on.
  await server.call("POST", `/api/admin/vendors/${vendor.id}/requests`, {
    userId: "ADMIN",
    body: { requestType: "Onboarding - COI", status: "Approved", referenceNumber: "CASE-1" },
  });

  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const meRes = await vendorCall(server, "GET", "/api/vendor-portal/me", { token: loginRes.body.token });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.vendorName, vendor.name);
  assert.equal(meRes.body.approvedCount, 1);
  assert.equal(meRes.body.totalCount, 4, "all 4 canonical case types count unless explicitly marked not_required");
  const coiItem = meRes.body.items.find((i) => i.key === "coi");
  assert.equal(coiItem.status, "Approved");

  const adminSummaryRes = await server.call("GET", `/api/admin/vendors/${vendor.id}/requests`, { userId: "ADMIN" });
  const adminApproved = adminSummaryRes.body.filter((r) => String(r.status).trim().toLowerCase() === "approved").length;
  assert.equal(meRes.body.approvedCount, adminApproved, "portal and admin-side data must agree on what's actually approved");
});

test("Vendor portal: a vendor can set their own phone/email, which show up on the admin side -- PO email is NOT settable here", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const beforeRes = await vendorCall(server, "GET", "/api/vendor-portal/me", { token });
  assert.equal(beforeRes.body.phone, "");
  assert.equal(beforeRes.body.poEmail, "");

  // PO email is included in the body (as a naive client might still send),
  // but the route only ever reads phone/email -- it must come back
  // unchanged, since a PO email change is gated (see po-email-change-request
  // below), not instant like phone/email.
  const saveRes = await vendorCall(server, "PATCH", "/api/vendor-portal/contact-info", {
    token,
    body: { phone: "555-0100", email: "ops-updated@portaltest.test", poEmail: "po@portaltest.test" },
  });
  assert.equal(saveRes.status, 200);
  assert.equal(saveRes.body.phone, "555-0100");
  assert.equal(saveRes.body.email, "ops-updated@portaltest.test");
  assert.equal(saveRes.body.poEmail, undefined, "contact-info no longer returns or writes poEmail at all");

  const afterRes = await vendorCall(server, "GET", "/api/vendor-portal/me", { token });
  assert.equal(afterRes.body.phone, "555-0100");
  assert.equal(afterRes.body.poEmail, "", "PO email must still be blank -- contact-info never touched it");

  const adminRes = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
  const adminVendor = adminRes.body.find((v) => v.id === vendor.id);
  assert.equal(adminVendor.phone, "555-0100");
  assert.equal(adminVendor.email, "ops-updated@portaltest.test");
  assert.equal(adminVendor.poEmail, "", "PO email on the real vendor record must be untouched");
});

test("Vendor portal: contact-info rejects an invalid email, requires a session, and can't touch any other vendor field", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const noToken = await vendorCall(server, "PATCH", "/api/vendor-portal/contact-info", { body: { phone: "555-0100" } });
  assert.equal(noToken.status, 401);

  const badEmail = await vendorCall(server, "PATCH", "/api/vendor-portal/contact-info", { token, body: { email: "not-an-email" } });
  assert.equal(badEmail.status, 400);

  // Posting unrelated fields in the same body is silently ignored, not
  // applied -- this route only ever touches phone/email, however
  // creatively the request is shaped.
  const sneaky = await vendorCall(server, "PATCH", "/api/vendor-portal/contact-info", {
    token,
    body: { phone: "555-0199", name: "Hijacked Name", onboardingStage: "approved" },
  });
  assert.equal(sneaky.status, 200);

  const adminListRes = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
  const adminVendor = adminListRes.body.find((v) => v.id === vendor.id);
  assert.equal(adminVendor.name, vendor.name, "name must be untouched");
  assert.equal(adminVendor.onboardingStage, vendor.onboardingStage, "onboardingStage must be untouched");
  assert.equal(adminVendor.phone, "555-0199", "only the allowed field actually changed");

  // An internal admin/tech session can't reach this vendor-only route
  // either -- same invariant the existing cross-session test above checks
  // for every other portal route.
  const internalToken = await server.tokenFor("ADMIN");
  const asAdmin = await vendorCall(server, "PATCH", "/api/vendor-portal/contact-info", { token: internalToken, body: { phone: "555-0100" } });
  assert.equal(asAdmin.status, 401);
});

// Part of task #18 (Vendor portal Phase 4): a PO email change is gated,
// not instant -- it's where real purchase orders get sent, so an
// unreviewed change could silently redirect them. Per Krista: the vendor
// requests it, admin reviews and updates the real PO email, then starts a
// new Payment/ACH compliance case on the vendor's behalf (the existing
// case-start flow) -- this route's only job is getting the ask in front
// of the right admin.
test("Vendor portal: PO email change request is gated -- creates an admin task, routes to the territory admin, and never writes the real po_email", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  raw.prepare("INSERT INTO locations (code, name, territory) VALUES (?, ?, ?)").run("PO-EMAIL-LOC", "PO Email Test Site", "East");
  raw
    .prepare("INSERT INTO technicians (id, name, pin, role, active, employment_status, home_location_code, email) VALUES (?, ?, ?, 'admin', 1, 'active', ?, ?)")
    .run("PO-EMAIL-ADMIN", "PO Email Admin", "0000", "PO-EMAIL-LOC", "po.email.admin@example.com");

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const now = new Date().toISOString();
  raw
    .prepare("INSERT INTO pos (composite_key, vendor_id, region, lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)")
    .run(crypto.randomUUID(), vendor.id, "East", now, now, now, now);

  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const noAuthRes = await vendorCall(server, "POST", "/api/vendor-portal/po-email-change-request", { body: { newPoEmail: "new@vendor.test" } });
  assert.equal(noAuthRes.status, 401);

  const badEmail = await vendorCall(server, "POST", "/api/vendor-portal/po-email-change-request", { token, body: { newPoEmail: "not-an-email" } });
  assert.equal(badEmail.status, 400);

  const res = await vendorCall(server, "POST", "/api/vendor-portal/po-email-change-request", { token, body: { newPoEmail: "new@vendor.test" } });
  assert.equal(res.status, 201);

  // The real po_email column is untouched -- only the pending-request fields are set.
  const adminVendorRes = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
  const adminVendor = adminVendorRes.body.find((v) => v.id === vendor.id);
  assert.equal(adminVendor.poEmail, "", "the real PO email must not change until admin acts");
  assert.equal(adminVendor.poEmailChangeRequested, "new@vendor.test");
  assert.ok(adminVendor.poEmailChangeRequestedAt);

  const meRes = await vendorCall(server, "GET", "/api/vendor-portal/me", { token });
  assert.equal(meRes.body.poEmailChangeRequested, "new@vendor.test");

  const tasksRes = await server.call(
    "GET",
    `/api/tasks?category=vendor_po_email_change_request&vendor=${vendor.id}&assignedTo=PO-EMAIL-ADMIN`,
    { userId: "ADMIN" }
  );
  assert.equal(tasksRes.body.length, 1, "routed to the vendor's own territory admin, same as help-request");
  assert.match(tasksRes.body[0].title, /requests a PO email change/);
  assert.match(tasksRes.body[0].description, /new@vendor\.test/);

  // Admin resolving it (editing the real PO email) clears the pending flag.
  const editRes = await server.call("PATCH", `/api/admin/vendors/${vendor.id}`, {
    userId: "ADMIN",
    body: { ...adminVendor, poEmail: "new@vendor.test" },
  });
  assert.equal(editRes.status, 200);
  assert.equal(editRes.body.poEmail, "new@vendor.test");
  assert.equal(editRes.body.poEmailChangeRequested, null, "updating the real PO email resolves the pending request");
});

// The core safety invariant the whole portal design rests on: a vendor's
// own session token must be structurally impossible to use anywhere an
// internal admin/technician session is checked, and vice versa.
test("Vendor portal: a vendor session token is rejected by internal admin/tech routes, and an internal token is rejected by the portal", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const vendorToken = loginRes.body.token;

  // A vendor token sent as x-session-token (the internal header) must not
  // work on an admin route or a technician route.
  const asAdminHeader = await fetch(server.baseUrl + "/api/admin/vendors", { headers: { "x-session-token": vendorToken } });
  assert.equal(asAdminHeader.status, 401);
  const asTechHeader = await fetch(server.baseUrl + "/api/woms", { headers: { "x-session-token": vendorToken } });
  assert.equal(asTechHeader.status, 401);

  // And the reverse: a real internal admin token sent as the vendor
  // header must not grant portal access.
  const adminToken = await server.tokenFor("ADMIN");
  const asVendorHeader = await vendorCall(server, "GET", "/api/vendor-portal/me", { token: adminToken });
  assert.equal(asVendorHeader.status, 401);
});

test("Vendor portal: logout invalidates the session immediately", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const beforeLogout = await vendorCall(server, "GET", "/api/vendor-portal/me", { token });
  assert.equal(beforeLogout.status, 200);

  const logoutRes = await vendorCall(server, "POST", "/api/vendor-portal/logout", { token });
  assert.equal(logoutRes.status, 200);

  const afterLogout = await vendorCall(server, "GET", "/api/vendor-portal/me", { token });
  assert.equal(afterLogout.status, 401);
});

test("Vendor portal: revoking access deletes the credential and any live session, and blocks a new login", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const revokeRes = await server.call("DELETE", `/api/admin/vendors/${vendor.id}/portal-credential`, { userId: "ADMIN" });
  assert.equal(revokeRes.status, 200);

  const afterRevoke = await vendorCall(server, "GET", "/api/vendor-portal/me", { token });
  assert.equal(afterRevoke.status, 401, "revoking should kill the already-live session too, not just future logins");

  const reloginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  assert.equal(reloginRes.status, 401);
});

test("Vendor portal: resetting the passcode invalidates the old one and any session logged in under it", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode: oldPasscode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode: oldPasscode } });
  const oldToken = loginRes.body.token;

  const resetRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/portal-credential`, { userId: "ADMIN", body: {} });
  assert.equal(resetRes.status, 200);
  const newPasscode = resetRes.body.passcode;
  assert.notEqual(newPasscode, oldPasscode);

  const withOldToken = await vendorCall(server, "GET", "/api/vendor-portal/me", { token: oldToken });
  assert.equal(withOldToken.status, 401, "a passcode reset should kill the session issued under the old one");

  const oldLoginAgain = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode: oldPasscode } });
  assert.equal(oldLoginAgain.status, 401);

  const newLogin = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode: newPasscode } });
  assert.equal(newLogin.status, 200);
});

test("Vendor portal: a vendor with no Tax ID on file gets a system access code instead, and can log in with it", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "No Tax ID Co" } });
  const credRes = await server.call("POST", `/api/admin/vendors/${vendorRes.body.id}/portal-credential`, { userId: "ADMIN", body: {} });
  assert.equal(credRes.status, 200, JSON.stringify(credRes.body));
  assert.equal(credRes.body.taxId, null);
  assert.match(credRes.body.accessCode, /^VP-/);
  assert.ok(credRes.body.passcode);

  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId: credRes.body.accessCode, passcode: credRes.body.passcode } });
  assert.equal(loginRes.status, 200, JSON.stringify(loginRes.body));
  assert.equal(loginRes.body.id, vendorRes.body.id);

  // Idempotent: a second "Reset passcode" call keeps the same access code
  // and only changes the passcode.
  const credRes2 = await server.call("POST", `/api/admin/vendors/${vendorRes.body.id}/portal-credential`, { userId: "ADMIN", body: {} });
  assert.equal(credRes2.body.accessCode, credRes.body.accessCode);
  assert.notEqual(credRes2.body.passcode, credRes.body.passcode);
});

test("Vendor portal: once a vendor's Tax ID is set, portal-credential stops surfacing the access code, but it still logs in", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Later Tax ID Co" } });
  const credRes = await server.call("POST", `/api/admin/vendors/${vendorRes.body.id}/portal-credential`, { userId: "ADMIN", body: {} });
  const accessCode = credRes.body.accessCode;

  const updateRes = await server.call("PATCH", `/api/admin/vendors/${vendorRes.body.id}`, { userId: "ADMIN", body: { name: vendorRes.body.name, taxId: "55-7654321" } });
  assert.equal(updateRes.status, 200, JSON.stringify(updateRes.body));

  const credRes2 = await server.call("POST", `/api/admin/vendors/${vendorRes.body.id}/portal-credential`, { userId: "ADMIN", body: {} });
  assert.equal(credRes2.body.taxId, "55-7654321");
  assert.equal(credRes2.body.accessCode, null);

  // The old access code is never retired -- still logs in.
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId: accessCode, passcode: credRes2.body.passcode } });
  assert.equal(loginRes.status, 200, JSON.stringify(loginRes.body));
});

test("Vendor portal: a vendor can self-report their Tax ID, with a conflict against an existing vendor caught and flagged to admin", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const existingRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Already On File Co", taxId: "44-9988776" } });
  assert.equal(existingRes.status, 201);

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "New Vendor Co" } });
  const credRes = await server.call("POST", `/api/admin/vendors/${vendorRes.body.id}/portal-credential`, { userId: "ADMIN", body: {} });
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId: credRes.body.accessCode, passcode: credRes.body.passcode } });
  const token = loginRes.body.token;

  const noAuthRes = await vendorCall(server, "PATCH", "/api/vendor-portal/tax-id", { body: { taxId: "11-2223333" } });
  assert.equal(noAuthRes.status, 401);

  const missingRes = await vendorCall(server, "PATCH", "/api/vendor-portal/tax-id", { token, body: {} });
  assert.equal(missingRes.status, 400);

  // Conflict: already on file for a different vendor.
  const conflictRes = await vendorCall(server, "PATCH", "/api/vendor-portal/tax-id", { token, body: { taxId: "44-9988776" } });
  assert.equal(conflictRes.status, 409);
  assert.doesNotMatch(conflictRes.body.error, /Already On File Co/, "must never name the other vendor to the self-reporting vendor");

  const meAfterConflict = await vendorCall(server, "GET", "/api/vendor-portal/me", { token });
  assert.equal(meAfterConflict.body.taxId, null, "a conflicting Tax ID is never saved");

  const tasksRes = await server.call("GET", "/api/tasks?category=vendor_tax_id_conflict", { userId: "ADMIN" });
  assert.equal(tasksRes.body.length, 1);
  assert.equal(tasksRes.body[0].relatedVendorId, vendorRes.body.id);
  assert.match(tasksRes.body[0].title, /Already On File Co/);
  assert.match(tasksRes.body[0].description, /New Vendor Co/);
  assert.match(tasksRes.body[0].description, /Already On File Co/);

  // No conflict: a fresh, unique Tax ID saves normally.
  const okRes = await vendorCall(server, "PATCH", "/api/vendor-portal/tax-id", { token, body: { taxId: "11-2223333" } });
  assert.equal(okRes.status, 200, JSON.stringify(okRes.body));
  assert.equal(okRes.body.taxId, "11-2223333");

  const meAfterOk = await vendorCall(server, "GET", "/api/vendor-portal/me", { token });
  assert.equal(meAfterOk.body.taxId, "11-2223333");

  // Resubmitting the vendor's own existing value is fine -- no new task.
  const resubmitRes = await vendorCall(server, "PATCH", "/api/vendor-portal/tax-id", { token, body: { taxId: "11-2223333" } });
  assert.equal(resubmitRes.status, 200);
  const tasksAfterResubmit = await server.call("GET", "/api/tasks?category=vendor_tax_id_conflict", { userId: "ADMIN" });
  assert.equal(tasksAfterResubmit.body.length, 1, "resubmitting your own value should not create a second task");
});

test("Vendor portal: Submit for review is rejected without a Tax ID on file, even with every case approved", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  // Strip the Tax ID back off via a direct admin edit, simulating a vendor
  // who somehow has every case approved but no Tax ID on file yet.
  await server.call("PATCH", `/api/admin/vendors/${vendor.id}`, { userId: "ADMIN", body: { name: vendor.name, taxId: "" } });

  const res = await vendorCall(server, "POST", "/api/vendor-portal/submit-for-review", { token });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Tax ID/);
});

test("Vendor portal: two vendors can't share the same Tax ID", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const firstRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "First Co", taxId: "99-1111111" } });
  assert.equal(firstRes.status, 201);
  const secondRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Second Co", taxId: "99-1111111" } });
  assert.equal(secondRes.status, 400);
  assert.match(secondRes.body.error, /Tax ID.*already on file/);
});

test("Vendor portal: a vendor can upload their own document, which lands in the same files table an admin upload would", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const uploadRes = await vendorUpload(server, "/api/vendor-portal/documents", {
    token,
    fields: { category: "w9" },
    fileName: "w9.pdf",
    fileContent: "fake w9 content",
    mimeType: "application/pdf",
  });
  assert.equal(uploadRes.status, 201, JSON.stringify(uploadRes.body));
  assert.equal(uploadRes.body.file.category, "w9");
  assert.equal(uploadRes.body.file.relatedType, "vendor");
  assert.equal(uploadRes.body.file.uploadedBy, `Vendor: ${vendor.name}`);
  assert.equal(uploadRes.body.coiReview, null, "a non-COI upload should never start a COI review");

  // Visible through the exact same admin-side read an uploaded-by-admin
  // file would use -- nothing admin-side has to change to see it.
  const adminFilesRes = await server.call("GET", `/api/files?relatedType=vendor&relatedId=${vendor.id}`, { userId: "ADMIN" });
  assert.equal(adminFilesRes.status, 200);
  assert.equal(adminFilesRes.body.length, 1);
  assert.equal(adminFilesRes.body[0].id, uploadRes.body.file.id);

  const historyRes = await vendorCall(server, "GET", "/api/vendor-portal/documents", { token });
  assert.equal(historyRes.status, 200);
  assert.equal(historyRes.body.length, 1);
  assert.equal(historyRes.body[0].category, "w9");
});

test("Vendor portal: a COI upload automatically starts the same review pipeline an admin's manual upload would", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server, { services: "Corporate Administrative / Marketing & Communications / Commercial Printing & Finishing" });
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const uploadRes = await vendorUpload(server, "/api/vendor-portal/documents", {
    token,
    fields: { category: "coi" },
    fileName: "coi.pdf",
    // Not a real PDF -- extraction is expected to fail quietly and return
    // empty text (see coiDocumentReview.js's own comment on that), the
    // same as an admin uploading a flat scan with no text layer. The
    // review itself should still be created either way.
    fileContent: "not a real pdf",
    mimeType: "application/pdf",
  });
  assert.equal(uploadRes.status, 201, JSON.stringify(uploadRes.body));
  assert.ok(uploadRes.body.coiReview, "a COI upload should start a review");
  assert.equal(uploadRes.body.coiReview.status, "pending");
  assert.equal(uploadRes.body.coiReview.vendorId, vendor.id);
  // The vendor-facing portal's requirement-checklist display (portal.js's
  // renderCoiReviewResult) depends on this array being present in the
  // response -- protects that contract.
  assert.ok(Array.isArray(uploadRes.body.coiReview.checklist), "coiReview.checklist should be the full requirement list");
  assert.ok(uploadRes.body.coiReview.checklist.length > 0, "a registered service type should produce at least the universal requirements");

  const reviewsRes = await server.call("GET", `/api/admin/vendors/${vendor.id}/coi-reviews`, { userId: "ADMIN" });
  assert.equal(reviewsRes.status, 200);
  assert.equal(reviewsRes.body.length, 1);
  assert.equal(reviewsRes.body[0].fileId, uploadRes.body.file.id);
});

test("Vendor portal: upload rejects a category a vendor isn't allowed to submit, and requires a logged-in session", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const badCategoryRes = await vendorUpload(server, "/api/vendor-portal/documents", {
    token,
    fields: { category: "vpo_waiver" },
  });
  assert.equal(badCategoryRes.status, 400);
  assert.match(badCategoryRes.body.error, /category must be one of/);

  const noAuthRes = await vendorUpload(server, "/api/vendor-portal/documents", { fields: { category: "w9" } });
  assert.equal(noAuthRes.status, 401);
});

// Per Krista: admins shouldn't have to open a vendor's profile to notice
// it's asking for something -- a visible count on both the vendor's own
// Overview tab and the Directory list card, not buried.
test("Vendor portal: a vendor's own open requests (not just any admin task) show up as vendorRequestCount, on both the single-vendor and bulk Directory paths", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const zeroRes = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
  assert.equal(zeroRes.body.find((v) => v.id === vendor.id).vendorRequestCount, 0);

  await vendorCall(server, "POST", "/api/vendor-portal/help-request", { token, body: { message: "test" } });
  const poEmailRes = await vendorCall(server, "POST", "/api/vendor-portal/po-email-change-request", { token, body: { newPoEmail: "new@test.example" } });
  assert.equal(poEmailRes.status, 201);

  // A plain admin-created task on the same vendor (not source:"vendor_portal")
  // must NOT count -- vendorRequestCount is specifically the vendor's own asks.
  await server.call("POST", "/api/tasks", { userId: "ADMIN", body: { title: "Unrelated admin task", relatedVendorId: vendor.id } });

  const listRes = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
  const listVendor = listRes.body.find((v) => v.id === vendor.id);
  assert.equal(listVendor.vendorRequestCount, 2, "2 vendor-portal-sourced requests, the plain admin task excluded");

  // The bulk Directory path (listVendors) and the single-vendor path
  // (findVendor/presentVendorRow) compute this the same way -- no HTTP
  // route returns a single vendor directly, so this checks db.findVendor
  // itself, same as the vendor profile page would get.
  const db = require("../server/data/db");
  assert.equal(db.findVendor(vendor.id).vendorRequestCount, 2, "single-vendor path must match the bulk Directory path");
});

test("Vendor portal: 'Need help' creates an admin-visible task carrying the vendor and message", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const noAuthRes = await vendorCall(server, "POST", "/api/vendor-portal/help-request", { body: { message: "nope" } });
  assert.equal(noAuthRes.status, 401);

  const res = await vendorCall(server, "POST", "/api/vendor-portal/help-request", { token, body: { message: "Not sure which COI form to use" } });
  assert.equal(res.status, 201);

  const tasksRes = await server.call("GET", `/api/tasks?category=vendor_help_request&vendor=${vendor.id}`, { userId: "ADMIN" });
  assert.equal(tasksRes.status, 200);
  assert.equal(tasksRes.body.length, 1);
  assert.equal(tasksRes.body[0].relatedVendorId, vendor.id);
  assert.match(tasksRes.body[0].title, new RegExp(vendor.name));
  assert.equal(tasksRes.body[0].description, "Not sure which COI form to use");
});

// Part of task #18 (Vendor portal Phase 4): route "Request help" to the
// admin who actually covers the vendor's own territory when that's
// unambiguous -- derived from the vendor's own PO history (see
// db.getVendorTerritories/resolveVendorTerritoryAdmin), not guessed.
test("Vendor portal: 'Need help' routes to the vendor's own territory admin when unambiguous, falls back to the admin queue otherwise", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  raw.prepare("INSERT INTO locations (code, name, territory) VALUES (?, ?, ?)").run("HELP-EAST-LOC", "East Site", "East");
  raw.prepare("INSERT INTO locations (code, name, territory) VALUES (?, ?, ?)").run("HELP-WEST-LOC", "West Site", "West");
  raw
    .prepare("INSERT INTO technicians (id, name, pin, role, active, employment_status, home_location_code, email) VALUES (?, ?, ?, 'admin', 1, 'active', ?, ?)")
    .run("HELP-EAST-ADMIN", "East Admin", "0000", "HELP-EAST-LOC", "east.admin@example.com");

  function insertPo(vendorId, region) {
    const now = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO pos (composite_key, vendor_id, region, lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), vendorId, region, now, now, now, now);
  }

  await t.test("a vendor whose POs are all in one territory gets routed directly to that territory's admin", async () => {
    const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
    insertPo(vendor.id, "East");
    insertPo(vendor.id, "East");
    const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
    const res = await vendorCall(server, "POST", "/api/vendor-portal/help-request", { token: loginRes.body.token, body: { message: "Routing test" } });
    assert.equal(res.status, 201);

    // GET /api/tasks defaults to the caller's own "my work" view, which
    // only shows unassigned admin-role tasks plus ones assigned to the
    // caller themself -- an explicit assignedTo lookup (admin-only) is
    // needed to see a task routed to a DIFFERENT admin, same as any other
    // cross-employee lookup in this app.
    const tasksRes = await server.call("GET", `/api/tasks?category=vendor_help_request&vendor=${vendor.id}&assignedTo=HELP-EAST-ADMIN`, { userId: "ADMIN" });
    assert.equal(tasksRes.body.length, 1);
    assert.equal(tasksRes.body[0].assignedTo, "HELP-EAST-ADMIN");
  });

  await t.test("a vendor spanning more than one territory falls back to the unassigned admin queue, same as before", async () => {
    const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
    insertPo(vendor.id, "East");
    insertPo(vendor.id, "West");
    const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
    const res = await vendorCall(server, "POST", "/api/vendor-portal/help-request", { token: loginRes.body.token, body: { message: "Ambiguous routing test" } });
    assert.equal(res.status, 201);

    const tasksRes = await server.call("GET", `/api/tasks?category=vendor_help_request&vendor=${vendor.id}`, { userId: "ADMIN" });
    assert.ok(!tasksRes.body[0].assignedTo, "no single admin to route to -- should land in the shared admin queue, not guessed");
  });

  await t.test("a vendor with no PO/WOM history yet also falls back to the admin queue", async () => {
    const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
    const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
    const res = await vendorCall(server, "POST", "/api/vendor-portal/help-request", { token: loginRes.body.token, body: { message: "No history yet" } });
    assert.equal(res.status, 201);

    const tasksRes = await server.call("GET", `/api/tasks?category=vendor_help_request&vendor=${vendor.id}`, { userId: "ADMIN" });
    assert.ok(!tasksRes.body[0].assignedTo);
  });
});

test("Vendor portal: COI waiver request requires a reason and creates an admin-visible VPO waiver task", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const missingReason = await vendorCall(server, "POST", "/api/vendor-portal/coi-waiver-request", {
    token,
    body: { requirementKey: "gl_occ", requirementLabel: "General Liability $1M" },
  });
  assert.equal(missingReason.status, 400);
  assert.match(missingReason.body.error, /reason is required/);

  const ok = await vendorCall(server, "POST", "/api/vendor-portal/coi-waiver-request", {
    token,
    body: { requirementKey: "gl_occ", requirementLabel: "General Liability $1M", reason: "Our policy caps at $500k" },
  });
  assert.equal(ok.status, 201);

  const tasksRes = await server.call("GET", `/api/tasks?category=vendor_waiver_request&vendor=${vendor.id}`, { userId: "ADMIN" });
  assert.equal(tasksRes.body.length, 1);
  assert.equal(tasksRes.body[0].relatedVendorId, vendor.id);
  assert.match(tasksRes.body[0].title, /VPO waiver/);
  assert.match(tasksRes.body[0].description, /General Liability \$1M/);
  assert.match(tasksRes.body[0].description, /Our policy caps at \$500k/);
});

test("Vendor portal: coi-limit-confirmation records a self-reported limit or excess-coverage claim without touching approval status", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server, {
    services: "Corporate Administrative / Marketing & Communications / Commercial Printing & Finishing",
  });
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const uploadRes = await vendorUpload(server, "/api/vendor-portal/documents", {
    token,
    fields: { category: "coi" },
    fileName: "coi.pdf",
    fileContent: "not a real pdf",
    mimeType: "application/pdf",
  });
  assert.equal(uploadRes.status, 201, JSON.stringify(uploadRes.body));
  const review = uploadRes.body.coiReview;
  const limitItem = review.checklist.find((item) => "extractedGuess" in item);
  assert.ok(limitItem, "a registered service with real coverage requirements should produce at least one coverage-limit item");

  const noAuthRes = await vendorCall(server, "PATCH", "/api/vendor-portal/coi-limit-confirmation", {
    body: { reviewId: review.id, requirementKey: limitItem.key, response: { type: "confirmed", value: "$1,000,000" } },
  });
  assert.equal(noAuthRes.status, 401);

  const badType = await vendorCall(server, "PATCH", "/api/vendor-portal/coi-limit-confirmation", {
    token,
    body: { reviewId: review.id, requirementKey: limitItem.key, response: { type: "not_a_real_type" } },
  });
  assert.equal(badType.status, 400);
  assert.match(badType.body.error, /response\.type must be one of/);

  const missingValue = await vendorCall(server, "PATCH", "/api/vendor-portal/coi-limit-confirmation", {
    token,
    body: { reviewId: review.id, requirementKey: limitItem.key, response: { type: "confirmed" } },
  });
  assert.equal(missingValue.status, 400);
  assert.match(missingValue.body.error, /value is required/);

  const unknownKey = await vendorCall(server, "PATCH", "/api/vendor-portal/coi-limit-confirmation", {
    token,
    body: { reviewId: review.id, requirementKey: "not_a_real_requirement", response: { type: "confirmed", value: "$1,000,000" } },
  });
  assert.equal(unknownKey.status, 404);

  const ok = await vendorCall(server, "PATCH", "/api/vendor-portal/coi-limit-confirmation", {
    token,
    body: { reviewId: review.id, requirementKey: limitItem.key, response: { type: "confirmed", value: "$1,000,000" } },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.vendorLimitConfirmations[limitItem.key].value, "$1,000,000");
  assert.equal(ok.body.status, "pending", "a vendor's self-report never touches the review's own approval status");

  // A different review belonging to a different vendor is a 404, not a
  // silent cross-vendor write.
  const other = await createVendorWithPortalAccess(server, {
    services: "Corporate Administrative / Marketing & Communications / Commercial Printing & Finishing",
  });
  const otherLogin = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId: other.taxId, passcode: other.passcode } });
  const crossVendor = await vendorCall(server, "PATCH", "/api/vendor-portal/coi-limit-confirmation", {
    token: otherLogin.body.token,
    body: { reviewId: review.id, requirementKey: limitItem.key, response: { type: "confirmed", value: "$2,000,000" } },
  });
  assert.equal(crossVendor.status, 404);

  const excess = await vendorCall(server, "PATCH", "/api/vendor-portal/coi-limit-confirmation", {
    token,
    body: { reviewId: review.id, requirementKey: limitItem.key, response: { type: "excess_coverage", note: "Covered by our umbrella policy" } },
  });
  assert.equal(excess.status, 200);
  assert.equal(excess.body.vendorLimitConfirmations[limitItem.key].type, "excess_coverage");
  assert.equal(excess.body.vendorLimitConfirmations[limitItem.key].note, "Covered by our umbrella policy");

  const adminListRes = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
  const vendorAfter = adminListRes.body.find((v) => v.id === vendor.id);
  assert.equal(vendorAfter.onboardingStage, "not_started", "self-reporting a limit should never itself move the vendor's onboarding stage");
});

test("Vendor portal: Submit for review creates one task, and resubmitting refreshes it instead of duplicating", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const noAuthRes = await vendorCall(server, "POST", "/api/vendor-portal/submit-for-review");
  assert.equal(noAuthRes.status, 401);

  const first = await vendorCall(server, "POST", "/api/vendor-portal/submit-for-review", { token });
  assert.equal(first.status, 201);

  const second = await vendorCall(server, "POST", "/api/vendor-portal/submit-for-review", { token });
  assert.equal(second.status, 201);
  assert.equal(second.body.taskId, first.body.taskId, "resubmitting should refresh the same task, not create a new one");

  const tasksRes = await server.call("GET", `/api/tasks?category=vendor_submission&vendor=${vendor.id}`, { userId: "ADMIN" });
  assert.equal(tasksRes.body.length, 1, "exactly one task should exist after two submits");
  assert.equal(tasksRes.body[0].relatedVendorId, vendor.id);
});

// Seeds a PO directly against the raw pos table (same approach the admin
// Budget PO Tracker's own tests use) -- vendor_id set, status carrying the
// real-world "Pending Vendor Invoice" text verbatim.
function insertPo(raw, { poNumber, vendorId, status, locationCode, requestor, adminName, amount }) {
  const now = new Date().toISOString();
  const result = raw
    .prepare(
      `INSERT INTO pos (
        composite_key, po_number, date_requested, requestor, description, location_code, po_amount, status,
        vendor_id, admin_name, lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    )
    .run(`po-${poNumber}`, poNumber, now.slice(0, 10), requestor || null, "Test PO", locationCode || null, amount || 0, status, vendorId, adminName || null, now, now, now, now);
  return Number(result.lastInsertRowid);
}

test("Vendor portal: 'My Open POs' only shows this vendor's POs with a Pending Vendor Invoice status, and is gated on Tax ID", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const other = await createVendorWithPortalAccess(server);

  const openPoId = insertPo(raw, { poNumber: "PO-OPEN-1", vendorId: vendor.id, status: "Pending Vendor Invoice", requestor: "Logan Pearl" });
  insertPo(raw, { poNumber: "PO-CLOSED-1", vendorId: vendor.id, status: "Closed" });
  insertPo(raw, { poNumber: "PO-OTHER-1", vendorId: other.vendor.id, status: "Pending Vendor Invoice" });

  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const res = await vendorCall(server, "GET", "/api/vendor-portal/pos", { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1, "only the Pending Vendor Invoice PO for this vendor should show up");
  assert.equal(res.body[0].id, openPoId);
  assert.equal(res.body[0].poNumber, "PO-OPEN-1");
  assert.equal(res.body[0].requestor, "Logan Pearl");
  assert.deepEqual(res.body[0].invoices, []);

  // No Tax ID on file -- the whole section should 400, even with a valid session.
  const noTaxVendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "No Tax Co", email: "notax@portaltest.test", taxId: "" } });
  const credRes = await server.call("POST", `/api/admin/vendors/${noTaxVendorRes.body.id}/portal-credential`, { userId: "ADMIN", body: {} });
  const noTaxLogin = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId: credRes.body.accessCode, passcode: credRes.body.passcode } });
  const noTaxToken = noTaxLogin.body.token;

  const gatedRes = await vendorCall(server, "GET", "/api/vendor-portal/pos", { token: noTaxToken });
  assert.equal(gatedRes.status, 400);
});

test("Vendor portal: 'Can't find your PO?' creates a vendor_po_request task", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const emptyRes = await vendorCall(server, "POST", "/api/vendor-portal/po-request", { token, body: {} });
  assert.equal(emptyRes.status, 400);

  const res = await vendorCall(server, "POST", "/api/vendor-portal/po-request", { token, body: { poNumber: "PO-9999", notes: "Can't find this one anywhere" } });
  assert.equal(res.status, 201);

  const tasksRes = await server.call("GET", `/api/tasks?category=vendor_po_request&vendor=${vendor.id}`, { userId: "ADMIN" });
  assert.equal(tasksRes.body.length, 1);
  assert.match(tasksRes.body[0].title, /PO-9999/);
  assert.equal(tasksRes.body[0].description, "Can't find this one anywhere");
});

test("Vendor portal: submitting an invoice saves it (even without SendGrid configured), rejects non-PDFs, and scopes to the vendor's own PO", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const other = await createVendorWithPortalAccess(server);
  const poId = insertPo(raw, { poNumber: "PO-INV-1", vendorId: vendor.id, status: "Pending Vendor Invoice", requestor: "Logan Pearl" });
  const otherPoId = insertPo(raw, { poNumber: "PO-INV-OTHER", vendorId: other.vendor.id, status: "Pending Vendor Invoice" });

  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const notPdf = await vendorUpload(server, `/api/vendor-portal/pos/${poId}/invoices`, {
    token,
    fields: { invoiceNumber: "INV-1" },
    fileName: "invoice.txt",
    fileContent: "not a pdf",
    mimeType: "text/plain",
  });
  assert.equal(notPdf.status, 400);

  const missingNumber = await vendorUpload(server, `/api/vendor-portal/pos/${poId}/invoices`, {
    token,
    fields: {},
    fileName: "invoice.pdf",
    fileContent: "%PDF-1.4 fake",
    mimeType: "application/pdf",
  });
  assert.equal(missingNumber.status, 400);

  const crossVendor = await vendorUpload(server, `/api/vendor-portal/pos/${otherPoId}/invoices`, {
    token,
    fields: { invoiceNumber: "INV-1" },
    fileName: "invoice.pdf",
    fileContent: "%PDF-1.4 fake",
    mimeType: "application/pdf",
  });
  assert.equal(crossVendor.status, 404, "a vendor should never be able to attach an invoice to another vendor's PO");

  const res = await vendorUpload(server, `/api/vendor-portal/pos/${poId}/invoices`, {
    token,
    fields: { invoiceNumber: "INV-555" },
    fileName: "invoice.pdf",
    fileContent: "%PDF-1.4 fake",
    mimeType: "application/pdf",
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.invoice.invoiceNumber, "INV-555");
  assert.equal(res.body.emailStatus, "not_configured", "SendGrid isn't configured in this test run -- this is the honest, no-crash outcome");

  const failedTaskRes = await server.call("GET", `/api/tasks?category=vendor_invoice_email_failed&vendor=${vendor.id}`, { userId: "ADMIN" });
  assert.equal(failedTaskRes.body.length, 0, "a merely-unconfigured send should never create a delivery-failure task");

  const listRes = await vendorCall(server, "GET", "/api/vendor-portal/pos", { token });
  assert.equal(listRes.body[0].invoices.length, 1);
  assert.equal(listRes.body[0].invoices[0].invoiceNumber, "INV-555");

  const adminInvoicesRes = await server.call("GET", `/api/admin/pos/${poId}/vendor-invoices`, { userId: "ADMIN" });
  assert.equal(adminInvoicesRes.status, 200);
  assert.equal(adminInvoicesRes.body.length, 1);
  assert.equal(adminInvoicesRes.body[0].invoiceNumber, "INV-555");
});
