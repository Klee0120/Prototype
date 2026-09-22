const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("roster: technician profile (basic info, onboarding, devices, history)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("roster list includes the new profile fields", async () => {
    const res = await server.call("GET", "/api/admin/technicians", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const t1001 = res.body.find((r) => r.id === "T1001");
    assert.equal(t1001.ukgId, "5945928");
    assert.equal(t1001.position, "Maintenance Technician");
    assert.equal(t1001.employmentStatus, "active");
  });

  await t.test("a technician cannot access the roster", async () => {
    const res = await server.call("GET", "/api/admin/technicians", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("admin can update basic info", async () => {
    const res = await server.call("PATCH", "/api/admin/technicians/T1001/basic-info", {
      userId: "ADMIN",
      body: {
        email: "new@example.com",
        phone: "555-1111",
        ukgId: "999",
        position: "Lead Tech",
        hireDate: "2026-01-12",
        terminationDate: "",
        standardDailyHours: 8,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.email, "new@example.com");
    assert.equal(res.body.position, "Lead Tech");
    assert.equal(res.body.hireDate, "2026-01-12");
    assert.equal(res.body.terminationDate, null);
    assert.equal(res.body.standardDailyHours, 8);
  });

  await t.test("a technician can set their own notification preference once they have an email on file", async () => {
    const res = await server.call("PATCH", "/api/technicians/T1001/notification-pref", {
      userId: "T1001",
      body: { notificationPref: "email" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.notificationPref, "email");

    const list = await server.call("GET", "/api/admin/technicians", { userId: "ADMIN" });
    assert.equal(list.body.find((r) => r.id === "T1001").notificationPref, "email");
  });

  await t.test("cannot switch to email without an email on file", async () => {
    const create = await server.call("POST", "/api/admin/technicians", {
      userId: "ADMIN",
      body: { id: "T-NOEMAIL", name: "No Email Tech", pin: "1111" },
    });
    assert.equal(create.status, 201);

    const res = await server.call("PATCH", "/api/technicians/T-NOEMAIL/notification-pref", {
      userId: "ADMIN",
      body: { notificationPref: "email" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("a technician cannot set another technician's notification preference", async () => {
    const res = await server.call("PATCH", "/api/technicians/T1002/notification-pref", {
      userId: "T1001",
      body: { notificationPref: "in_app" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("rejects an invalid notification preference value", async () => {
    const res = await server.call("PATCH", "/api/technicians/T1001/notification-pref", {
      userId: "T1001",
      body: { notificationPref: "carrier_pigeon" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("rejects a malformed hire/termination date or a negative standard daily hours", async () => {
    const badDate = await server.call("PATCH", "/api/admin/technicians/T1001/basic-info", {
      userId: "ADMIN",
      body: { hireDate: "01/12/2026" },
    });
    assert.equal(badDate.status, 400);

    const badHours = await server.call("PATCH", "/api/admin/technicians/T1001/basic-info", {
      userId: "ADMIN",
      body: { standardDailyHours: -1 },
    });
    assert.equal(badHours.status, 400);
  });

  await t.test("admin can change employment status", async () => {
    const off = await server.call("PATCH", "/api/admin/technicians/T1001/employment-status", {
      userId: "ADMIN",
      body: { status: "terminated" },
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.employmentStatus, "terminated");

    const list = await server.call("GET", "/api/admin/technicians", { userId: "ADMIN" });
    assert.equal(list.body.find((r) => r.id === "T1001").employmentStatus, "terminated");

    const loginBlocked = await server.call("POST", "/api/auth/login", { body: { id: "T1001", pin: "1234" } });
    assert.equal(loginBlocked.status, 401);

    await server.call("PATCH", "/api/admin/technicians/T1001/employment-status", { userId: "ADMIN", body: { status: "active" } });
  });

  await t.test("rejects an unknown employment status value", async () => {
    const res = await server.call("PATCH", "/api/admin/technicians/T1001/employment-status", {
      userId: "ADMIN",
      body: { status: "bogus" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("admin can create a new technician", async () => {
    const res = await server.call("POST", "/api/admin/technicians", {
      userId: "ADMIN",
      body: { id: "T1099", name: "Casey New", pin: "4321", position: "Technician", homeLocationCode: "PRINCETON" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.employmentStatus, "active");

    const login = await server.call("POST", "/api/auth/login", { body: { id: "T1099", pin: "4321" } });
    assert.equal(login.status, 200);
  });

  await t.test("cannot create a technician with a duplicate ID", async () => {
    const res = await server.call("POST", "/api/admin/technicians", {
      userId: "ADMIN",
      body: { id: "T1001", name: "Dupe", pin: "1111" },
    });
    assert.equal(res.status, 409);
  });

  await t.test("a technician cannot create another technician", async () => {
    const res = await server.call("POST", "/api/admin/technicians", {
      userId: "T1002",
      body: { id: "T1098", name: "Nope", pin: "1111" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("onboarding starts with all tasks incomplete and can be checked off", async () => {
    const initial = await server.call("GET", "/api/admin/technicians/T1001/onboarding", { userId: "ADMIN" });
    assert.equal(initial.status, 200);
    assert.ok(initial.body.every((task) => task.completedAt === null));

    const updated = await server.call("PATCH", "/api/admin/technicians/T1001/onboarding/badge_issued", {
      userId: "ADMIN",
      body: { completed: true },
    });
    assert.equal(updated.status, 200);
    const badge = updated.body.find((tsk) => tsk.key === "badge_issued");
    assert.ok(badge.completedAt);

    const uncheck = await server.call("PATCH", "/api/admin/technicians/T1001/onboarding/badge_issued", {
      userId: "ADMIN",
      body: { completed: false },
    });
    assert.equal(uncheck.body.find((tsk) => tsk.key === "badge_issued").completedAt, null);
  });

  await t.test("rejects an unknown onboarding task key", async () => {
    const res = await server.call("PATCH", "/api/admin/technicians/T1001/onboarding/not-a-task", {
      userId: "ADMIN",
      body: { completed: true },
    });
    assert.equal(res.status, 400);
  });

  await t.test("devices can be assigned and removed, and require a valid deviceType", async () => {
    const empty = await server.call("GET", "/api/admin/technicians/T1001/devices", { userId: "ADMIN" });
    assert.deepEqual(empty.body, []);

    const badType = await server.call("POST", "/api/admin/technicians/T1001/devices", {
      userId: "ADMIN",
      body: { deviceType: "tablet", deviceName: "iPad" },
    });
    assert.equal(badType.status, 400);

    const added = await server.call("POST", "/api/admin/technicians/T1001/devices", {
      userId: "ADMIN",
      body: { deviceType: "phone", deviceName: "555-0100", notes: "work phone" },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.length, 1);
    assert.equal(added.body[0].deviceType, "phone");
    assert.deepEqual(added.body[0].requests, []);
    const deviceId = added.body[0].id;

    const removed = await server.call("DELETE", `/api/admin/technicians/T1001/devices/${deviceId}`, { userId: "ADMIN" });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, []);
  });

  await t.test("an iPad device can be assigned with an optional plan", async () => {
    const added = await server.call("POST", "/api/admin/technicians/T1001/devices", {
      userId: "ADMIN",
      body: { deviceType: "ipad", deviceName: "IPAD-4471", plan: "Cellular unlimited" },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body[0].deviceType, "ipad");
    assert.equal(added.body[0].plan, "Cellular unlimited");
  });

  await t.test("device IT requests (e.g. Calero) can be logged and followed up on", async () => {
    const device = await server.call("POST", "/api/admin/technicians/T1001/devices", {
      userId: "ADMIN",
      body: { deviceType: "phone", deviceName: "555-0101" },
    });
    const deviceId = device.body[0].id;

    const added = await server.call("POST", `/api/admin/technicians/T1001/devices/${deviceId}/requests`, {
      userId: "ADMIN",
      body: { requestType: "Cancellation", referenceNumber: "CAL-4821" },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body[0].requestType, "Cancellation");
    assert.equal(added.body[0].referenceNumber, "CAL-4821");
    assert.equal(added.body[0].completedAt, null);
    const requestId = added.body[0].id;

    const completed = await server.call(
      "PATCH",
      `/api/admin/technicians/T1001/devices/${deviceId}/requests/${requestId}`,
      { userId: "ADMIN", body: { completed: true } }
    );
    assert.equal(completed.status, 200);
    assert.ok(completed.body[0].completedAt);

    const reopened = await server.call(
      "PATCH",
      `/api/admin/technicians/T1001/devices/${deviceId}/requests/${requestId}`,
      { userId: "ADMIN", body: { completed: false } }
    );
    assert.equal(reopened.body[0].completedAt, null);

    const edited = await server.call(
      "PATCH",
      `/api/admin/technicians/T1001/devices/${deviceId}/requests/${requestId}`,
      { userId: "ADMIN", body: { requestType: "Line transfer", referenceNumber: "CAL-9999" } }
    );
    assert.equal(edited.status, 200);
    assert.equal(edited.body[0].requestType, "Line transfer");
    assert.equal(edited.body[0].referenceNumber, "CAL-9999");
  });

  await t.test("a technician cannot manage another technician's devices or onboarding", async () => {
    const devices = await server.call("POST", "/api/admin/technicians/T1001/devices", {
      userId: "T1002",
      body: { deviceType: "laptop", deviceName: "Laptop" },
    });
    assert.equal(devices.status, 403);

    const onboarding = await server.call("PATCH", "/api/admin/technicians/T1001/onboarding/badge_issued", {
      userId: "T1002",
      body: { completed: true },
    });
    assert.equal(onboarding.status, 403);
  });

  await t.test("allocation history returns a technician's past weeks", async () => {
    const res = await server.call("GET", "/api/admin/technicians/T1001/history", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0);
    assert.ok(res.body.every((row) => "weekMonday" in row && "hours" in row && "weekStatus" in row));
  });

  await t.test("a technician cannot bulk-create technicians", async () => {
    const res = await server.call("POST", "/api/admin/technicians/bulk", {
      userId: "T1001",
      body: { rows: [{ id: "T-BULK-1", name: "Bulk One" }] },
    });
    assert.equal(res.status, 403);
  });

  await t.test("admin can bulk-create technicians, each with its own generated PIN", async () => {
    const res = await server.call("POST", "/api/admin/technicians/bulk", {
      userId: "ADMIN",
      body: {
        rows: [
          { id: "T-BULK-1", name: "Bulk One", position: "Maintenance Technician", email: "one@example.com" },
          { id: "T-BULK-2", name: "Bulk Two", homeLocationCode: "PRINCETON" },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.created.length, 2);
    assert.equal(res.body.errors.length, 0);
    // Each row gets its own randomly-generated 4-digit PIN, not a shared one.
    const [one, two] = res.body.created;
    assert.match(one.pin, /^\d{4}$/);
    assert.match(two.pin, /^\d{4}$/);
    assert.notEqual(one.pin === two.pin && one.id === two.id, true);

    // The generated PIN actually works to log in.
    const login = await server.call("POST", "/api/auth/login", { body: { id: "T-BULK-1", pin: one.pin } });
    assert.equal(login.status, 200);

    const list = await server.call("GET", "/api/admin/technicians", { userId: "ADMIN" });
    assert.ok(list.body.some((t) => t.id === "T-BULK-1" && t.position === "Maintenance Technician"));
    assert.ok(list.body.some((t) => t.id === "T-BULK-2" && t.homeLocationCode === "PRINCETON"));
  });

  await t.test("bulk-create skips a bad row (missing name, duplicate id, unknown location) without failing the rest", async () => {
    const res = await server.call("POST", "/api/admin/technicians/bulk", {
      userId: "ADMIN",
      body: {
        rows: [
          { id: "T-BULK-3", name: "Bulk Three" },
          { id: "T-BULK-1", name: "Duplicate Of One" },
          { id: "", name: "No Id" },
          { id: "T-BULK-4", name: "Bulk Four", homeLocationCode: "NOPE" },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.created.length, 1);
    assert.equal(res.body.created[0].id, "T-BULK-3");
    assert.equal(res.body.errors.length, 3);
    assert.ok(res.body.errors.some((e) => e.id === "T-BULK-1" && /already in use/.test(e.error)));
    assert.ok(res.body.errors.some((e) => e.error === "id and name are required"));
    assert.ok(res.body.errors.some((e) => e.id === "T-BULK-4" && /Unknown location/.test(e.error)));
  });

  await t.test("bulk-create 400s if every row fails", async () => {
    const res = await server.call("POST", "/api/admin/technicians/bulk", {
      userId: "ADMIN",
      body: { rows: [{ id: "T-BULK-1", name: "Still Duplicate" }] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.created.length, 0);
  });

  await t.test("bulk-create rejects an empty or missing rows array", async () => {
    const res = await server.call("POST", "/api/admin/technicians/bulk", { userId: "ADMIN", body: { rows: [] } });
    assert.equal(res.status, 400);
  });

  await t.test("a technician cannot delete a technician", async () => {
    const res = await server.call("DELETE", "/api/admin/technicians/T-BULK-3", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("deleting an unknown technician 404s", async () => {
    const res = await server.call("DELETE", "/api/admin/technicians/T-NOPE", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });

  await t.test("admin can delete a technician with no allocated hours", async () => {
    const del = await server.call("DELETE", "/api/admin/technicians/T-BULK-3", { userId: "ADMIN" });
    assert.equal(del.status, 200);

    const list = await server.call("GET", "/api/admin/technicians", { userId: "ADMIN" });
    assert.ok(!list.body.some((t) => t.id === "T-BULK-3"));
  });

  await t.test("deleting a technician with allocated hours is blocked unless forced", async () => {
    const before = await server.call("GET", "/api/woms", { userId: "ADMIN" });
    const usedBefore = before.body.find((w) => w.code === "WOM-4471").usedHours || 0;

    const meta = await server.call("GET", "/api/meta/current-week");
    const week = meta.body.weekMonday;
    const alloc = await server.call("PUT", `/api/technicians/T-BULK-2/weeks/${week}/allocations`, {
      userId: "ADMIN",
      body: { allocations: [{ day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4471", hours: 4 }] },
    });
    assert.equal(alloc.status, 200);

    const blocked = await server.call("DELETE", "/api/admin/technicians/T-BULK-2", { userId: "ADMIN" });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.allocatedHours, 4);

    const forced = await server.call("DELETE", "/api/admin/technicians/T-BULK-2", { userId: "ADMIN", body: { force: true } });
    assert.equal(forced.status, 200);

    const list = await server.call("GET", "/api/admin/technicians", { userId: "ADMIN" });
    assert.ok(!list.body.some((t) => t.id === "T-BULK-2"));

    // Their allocated hours went with them -- WOM-4471's usedHours is back
    // to what it was before, not left dangling on a deleted technician.
    const after = await server.call("GET", "/api/woms", { userId: "ADMIN" });
    assert.equal(after.body.find((w) => w.code === "WOM-4471").usedHours, usedBefore);
  });

  await t.test("deleting a technician never touches an admin account", async () => {
    const res = await server.call("DELETE", "/api/admin/technicians/ADMIN", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });
});
