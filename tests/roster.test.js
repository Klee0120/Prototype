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
      body: { email: "new@example.com", phone: "555-1111", ukgId: "999", position: "Lead Tech" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.email, "new@example.com");
    assert.equal(res.body.position, "Lead Tech");
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
});
