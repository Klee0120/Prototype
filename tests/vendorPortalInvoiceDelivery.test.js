// Its own file, deliberately: mailer.js reads SENDGRID_API_KEY/SENDGRID_FROM
// into module-level consts once, at require time -- so SendGrid must look
// "configured" before helpers.js's own first require of server/app (which
// pulls in vendorPortal.js -> mailer.js) pulls that module in. Every other
// vendorPortal test file runs with SendGrid deliberately unconfigured
// (matching this suite's dominant convention); mixing the two in one file
// would mean the first require wins for the whole file, not per test.
process.env.SENDGRID_API_KEY = "test-key";
process.env.SENDGRID_FROM = "serviceworks.noreply@example.com";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

async function vendorCall(server, method, urlPath, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["x-vendor-session-token"] = token;
  const res = await fetch(server.baseUrl + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

async function vendorUpload(server, urlPath, { token, fields = {}, fileName = "test.pdf", fileContent = "%PDF-1.4 fake", mimeType = "application/pdf" } = {}) {
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
  const suffix = crypto.randomUUID().slice(0, 8);
  const vendorRes = await server.call("POST", "/api/admin/vendors", {
    userId: "ADMIN",
    body: { name: `Delivery Test Co ${suffix}`, email: `ops-${suffix}@deliverytest.test`, taxId: `98-${suffix}`, ...overrides },
  });
  assert.equal(vendorRes.status, 201, JSON.stringify(vendorRes.body));
  const vendor = vendorRes.body;
  const credRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/portal-credential`, { userId: "ADMIN", body: {} });
  return { vendor, taxId: credRes.body.taxId, passcode: credRes.body.passcode };
}

function insertPo(raw, { poNumber, vendorId, status, locationCode, requestor, adminName }) {
  const now = new Date().toISOString();
  const result = raw
    .prepare(
      `INSERT INTO pos (
        composite_key, po_number, date_requested, requestor, description, location_code, po_amount, status,
        vendor_id, admin_name, lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    )
    .run(`po-${poNumber}`, poNumber, now.slice(0, 10), requestor || null, "Test PO", locationCode || null, 1500, status, vendorId, adminName || null, now, now, now, now);
  return Number(result.lastInsertRowid);
}

test("Vendor portal invoice delivery: real SendGrid payload carries the resolved admin cc and the PDF attachment", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  raw.prepare("INSERT INTO locations (code, name, territory) VALUES (?, ?, ?)").run("DELIV-LOC", "Delivery Test Site", "Midwest");
  raw
    .prepare("INSERT INTO technicians (id, name, pin, role, active, employment_status, home_location_code, email) VALUES (?, ?, ?, 'admin', 1, 'active', ?, ?)")
    .run("DELIV-ADMIN", "Pat Admin", "0000", "DELIV-LOC", "pat.admin@example.com");

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const poId = insertPo(raw, { poNumber: "PO-DELIV-1", vendorId: vendor.id, status: "Pending Vendor Invoice", locationCode: "DELIV-LOC", requestor: "Logan Pearl", adminName: "Pat Admin" });

  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const originalFetch = global.fetch;
  let capturedOptions = null;
  global.fetch = async (url, options) => {
    if (url === "https://api.sendgrid.com/v3/mail/send") {
      capturedOptions = options;
      return { ok: true, status: 202, text: async () => "" };
    }
    return originalFetch(url, options);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await vendorUpload(server, `/api/vendor-portal/pos/${poId}/invoices`, {
    token,
    fields: { invoiceNumber: "INV-DELIV-1" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.emailStatus, "sent");

  assert.ok(capturedOptions, "the real SendGrid send should have fired");
  const body = JSON.parse(capturedOptions.body);
  assert.equal(body.personalizations[0].to[0].email, "ap.amer@cwservices.com");
  assert.deepEqual(body.personalizations[0].cc, [{ email: "pat.admin@example.com" }]);
  assert.match(body.content[0].value, /PO-DELIV-1/);
  assert.match(body.content[0].value, /Logan Pearl/);
  assert.equal(body.attachments.length, 1);
  assert.equal(body.attachments[0].filename, "test.pdf");

  const invoicesRes = await server.call("GET", `/api/admin/pos/${poId}/vendor-invoices`, { userId: "ADMIN" });
  assert.equal(invoicesRes.body[0].emailStatus, "sent");
});

test("Vendor portal invoice delivery: a real SendGrid failure is saved as 'failed' and creates an admin task, never a 500 to the vendor", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  const { vendor, taxId, passcode } = await createVendorWithPortalAccess(server);
  const poId = insertPo(raw, { poNumber: "PO-DELIV-FAIL", vendorId: vendor.id, status: "Pending Vendor Invoice" });

  const loginRes = await vendorCall(server, "POST", "/api/vendor-portal/login", { body: { taxId, passcode } });
  const token = loginRes.body.token;

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url === "https://api.sendgrid.com/v3/mail/send") {
      return { ok: false, status: 401, text: async () => '{"errors":[{"message":"bad key"}]}' };
    }
    return originalFetch(url, options);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await vendorUpload(server, `/api/vendor-portal/pos/${poId}/invoices`, {
    token,
    fields: { invoiceNumber: "INV-DELIV-FAIL" },
  });
  assert.equal(res.status, 201, "the invoice must still be saved even when the AP email fails");
  assert.equal(res.body.emailStatus, "failed");
  assert.ok(res.body.invoice.id);

  const invoicesRes = await server.call("GET", `/api/admin/pos/${poId}/vendor-invoices`, { userId: "ADMIN" });
  assert.equal(invoicesRes.body[0].emailStatus, "failed");
  assert.match(invoicesRes.body[0].emailError, /401/);

  const failedTaskRes = await server.call("GET", `/api/tasks?category=vendor_invoice_email_failed&vendor=${vendor.id}`, { userId: "ADMIN" });
  assert.equal(failedTaskRes.body.length, 1, "a genuine delivery failure should create an admin task");
  assert.match(failedTaskRes.body[0].title, /PO-DELIV-FAIL/);
});
