const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

test("vendor compliance reminders: finding who's due, and the cadence throttle", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);

  let expiredId;
  let expiringSoonId;
  let noEmailId;
  let farOutId;

  await t.test("set up vendors: already-expired, expiring-soon, no-email, and far-out (shouldn't match)", async () => {
    const mk = async (name, email) => {
      const res = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name, email } });
      return res.body.id;
    };
    expiredId = await mk("Already Expired Co", "ops@alreadyexpired.test");
    expiringSoonId = await mk("Expiring Soon Co", "ops@expiringsoon.test");
    noEmailId = await mk("No Email Co", undefined);
    farOutId = await mk("Far Out Co", "ops@farout.test");

    const in10Days = new Date();
    in10Days.setDate(in10Days.getDate() + 10);
    const in60Days = new Date();
    in60Days.setDate(in60Days.getDate() + 60);

    await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor", relatedId: String(expiredId), category: "coi", expiresAt: "2020-01-01" },
      fileName: "coi.pdf",
    });
    await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor", relatedId: String(expiringSoonId), category: "w9", expiresAt: in10Days.toISOString().slice(0, 10) },
      fileName: "w9.pdf",
    });
    await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor", relatedId: String(noEmailId), category: "ach", expiresAt: "2020-01-01" },
      fileName: "ach.pdf",
    });
    await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor", relatedId: String(farOutId), category: "coi", expiresAt: in60Days.toISOString().slice(0, 10) },
      fileName: "coi.pdf",
    });
  });

  await t.test("listVendorsNeedingComplianceReminder finds the expired and expiring-soon vendors, labeled correctly", () => {
    const due = db.listVendorsNeedingComplianceReminder({ daysAhead: 30, cadenceDays: 7 });
    const ids = due.map((v) => v.id);
    assert.ok(ids.includes(expiredId), "expired vendor should be due");
    assert.ok(ids.includes(expiringSoonId), "expiring-soon vendor (within 30 days) should be due");

    const expired = due.find((v) => v.id === expiredId);
    assert.equal(expired.items[0].status, "expired");
    const expiring = due.find((v) => v.id === expiringSoonId);
    assert.equal(expiring.items[0].status, "expiring");
  });

  await t.test("a vendor with no email on file is skipped even though its COI is expired", () => {
    const due = db.listVendorsNeedingComplianceReminder({ daysAhead: 30, cadenceDays: 7 });
    assert.ok(!due.some((v) => v.id === noEmailId));
  });

  await t.test("a vendor whose document doesn't expire for 60 days is outside the default 30-day window", () => {
    const due = db.listVendorsNeedingComplianceReminder({ daysAhead: 30, cadenceDays: 7 });
    assert.ok(!due.some((v) => v.id === farOutId));
    // A wider window does catch it.
    const wider = db.listVendorsNeedingComplianceReminder({ daysAhead: 90, cadenceDays: 7 });
    assert.ok(wider.some((v) => v.id === farOutId));
  });

  await t.test("recording a reminder just sent excludes that vendor until the cadence window passes", () => {
    db.recordVendorComplianceReminderSent(expiredId);
    const dueRightAfter = db.listVendorsNeedingComplianceReminder({ daysAhead: 30, cadenceDays: 7 });
    assert.ok(!dueRightAfter.some((v) => v.id === expiredId), "shouldn't be re-flagged immediately after a reminder");

    // Backdate the reminder past the cadence window (raw SQL -- nothing
    // in the public API lets a test fast-forward "last contacted").
    const longAgo = new Date();
    longAgo.setDate(longAgo.getDate() - 8);
    raw.prepare("UPDATE vendors SET last_compliance_reminder_at = ? WHERE id = ?").run(longAgo.toISOString(), expiredId);

    const dueAgain = db.listVendorsNeedingComplianceReminder({ daysAhead: 30, cadenceDays: 7 });
    assert.ok(dueAgain.some((v) => v.id === expiredId), "should be due again once the cadence window has passed");
  });
});

test("vendor compliance reminders: sending the batch, and the manual-trigger route", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  let vendorId;

  await t.test("set up one vendor with an expired COI", async () => {
    const res = await server.call("POST", "/api/admin/vendors", {
      userId: "ADMIN",
      body: { name: "Batch Reminder Co", email: "ops@batchreminder.test" },
    });
    vendorId = res.body.id;
    await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor", relatedId: String(vendorId), category: "coi", expiresAt: "2020-01-01" },
      fileName: "coi.pdf",
    });
  });

  await t.test("a technician cannot trigger the batch", async () => {
    const res = await server.call("POST", "/api/admin/vendors/send-compliance-reminders", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("an admin can run it on demand and gets a summary back", async () => {
    const res = await server.call("POST", "/api/admin/vendors/send-compliance-reminders", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    // Not asserting an exact count -- other vendors from earlier tests in
    // this same file's shared database may also be due (helpers.js gives
    // each test *file* its own DB, not each top-level test()), so this
    // just confirms ours was among them, via the per-vendor audit entry
    // below.
    assert.ok(res.body.checked >= 1);
    assert.ok(res.body.emailed >= 1);
    assert.deepEqual(res.body.failures, []);
  });

  await t.test("it's audited", async () => {
    const audit = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const entry = audit.body.find((e) => e.action === "VENDOR_COMPLIANCE_REMINDERS_RUN");
    assert.ok(entry);
    assert.match(entry.details, /\d+\/\d+ emailed/);

    const perVendor = audit.body.find((e) => e.action === "VENDOR_COMPLIANCE_REMINDER_SENT" && e.details.includes("Batch Reminder Co"));
    assert.ok(perVendor);
    assert.match(perVendor.details, /Certificate of Insurance/);
  });

  await t.test("running it again immediately emails nobody -- the cadence throttle already covers this vendor", async () => {
    const res = await server.call("POST", "/api/admin/vendors/send-compliance-reminders", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.checked, 0);
    assert.equal(res.body.emailed, 0);
  });
});
