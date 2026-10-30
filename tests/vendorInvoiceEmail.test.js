const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// buildApInvoiceEmail is a pure function (no network, no writes) -- still
// needs a real db underneath it for db.resolvePoResponsibleAdmin's own
// lookups (technicians/locations), so this still goes through startServer
// the same way every other "pure logic" test in this suite does (see
// reclasses.test.js's resolveFiscalPeriod tests) rather than trying to
// avoid it.
test("buildApInvoiceEmail: cc resolution, auto-filled fields, and the policy reminder text", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { buildApInvoiceEmail } = require("../server/utils/vendorInvoiceEmail");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  raw.prepare("INSERT INTO locations (code, name, territory) VALUES (?, ?, ?)").run("INV-LOC", "Invoice Test Site", "Midwest");
  raw
    .prepare("INSERT INTO technicians (id, name, pin, role, active, employment_status, home_location_code, email) VALUES (?, ?, ?, 'admin', 1, 'active', ?, ?)")
    .run("INV-ADMIN", "Pat Admin", "0000", "INV-LOC", "pat.admin@example.com");

  const vendor = { name: "Acme Plumbing", phone: "555-1212", email: "billing@acme.example", poEmail: "po@acme.example" };

  await t.test("resolves the cc via a direct admin-name match on the PO", () => {
    const po = { id: 1, poNumber: "PO1001", locationName: "Invoice Test Site", locationCode: "INV-LOC", requestor: "Logan Pearl", adminName: "Pat Admin", territory: "Midwest" };
    const email = buildApInvoiceEmail(po, vendor, "INV-555");
    assert.equal(email.to, "ap.amer@cwservices.com");
    assert.deepEqual(email.cc, ["pat.admin@example.com"]);
    assert.match(email.subject, /PO1001/);
    assert.match(email.text, /Purchase Order Number: PO1001/);
    assert.match(email.text, /Location: Invoice Test Site/);
    assert.match(email.text, /Placed by: Logan Pearl/);
    assert.match(email.text, /Acme Plumbing/);
    assert.match(email.text, /555-1212/);
    assert.match(email.text, /INV-555/);
    assert.match(email.text, /Bill to: C&W FACILITY SERVICES INC/);
  });

  await t.test("falls back to the territory's own admin when the PO's admin name doesn't match anyone real", () => {
    const po = { id: 2, poNumber: "PO1002", locationCode: "INV-LOC", adminName: "Nobody Real", territory: "Midwest" };
    const email = buildApInvoiceEmail(po, vendor, "INV-556");
    assert.deepEqual(email.cc, ["pat.admin@example.com"]);
  });

  await t.test("no cc at all when neither the admin name nor the territory resolves to anyone", () => {
    const po = { id: 3, poNumber: "PO1003", adminName: "Nobody Real", territory: null };
    const email = buildApInvoiceEmail(po, vendor, "INV-557");
    assert.equal(email.cc, undefined);
  });

  await t.test("the opt-in safety-net cc env var is added alongside (or in place of) the resolved admin", () => {
    process.env.VENDOR_INVOICE_AP_SAFETY_CC = "safety@example.com";
    t.after(() => delete process.env.VENDOR_INVOICE_AP_SAFETY_CC);

    const resolved = buildApInvoiceEmail({ id: 1, poNumber: "PO1001", adminName: "Pat Admin", territory: "Midwest" }, vendor, "INV-558");
    assert.deepEqual(resolved.cc, ["pat.admin@example.com", "safety@example.com"]);

    const unresolved = buildApInvoiceEmail({ id: 3, poNumber: "PO1003", adminName: "Nobody Real", territory: null }, vendor, "INV-559");
    assert.deepEqual(unresolved.cc, ["safety@example.com"]);
  });

  await t.test("vendor contact falls back to poEmail when there's no direct email on file", () => {
    const noEmailVendor = { name: "No Email Co", phone: "555-9999", email: "", poEmail: "pos@noemail.example" };
    const po = { id: 4, poNumber: "PO1004" };
    const email = buildApInvoiceEmail(po, noEmailVendor, "INV-560");
    assert.match(email.text, /pos@noemail\.example/);
  });
});
