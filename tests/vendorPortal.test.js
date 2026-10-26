const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

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

test("Vendor portal: setting up access requires a Tax ID on file first", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "No Tax ID Co" } });
  const credRes = await server.call("POST", `/api/admin/vendors/${vendorRes.body.id}/portal-credential`, { userId: "ADMIN", body: {} });
  assert.equal(credRes.status, 400);
  assert.match(credRes.body.error, /Tax ID/);
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
