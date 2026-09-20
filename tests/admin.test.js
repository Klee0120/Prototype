const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

async function submitFullWeek(server, techId, week, locationCode) {
  const detail = await server.call("GET", `/api/technicians/${techId}/weeks/${week}`, { userId: techId });
  const allocations = Object.entries(detail.body.ukgHoursByDay)
    .filter(([, hours]) => hours > 0)
    .map(([day, hours]) => ({ day, type: "ef", locationCode, hours }));

  await server.call("PUT", `/api/technicians/${techId}/weeks/${week}/allocations`, { userId: techId, body: { allocations } });
  return server.call("POST", `/api/technicians/${techId}/weeks/${week}/submit`, { userId: techId });
}

test("admin: review, approve, reject, unlock, UKG hours, home location", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;

  await t.test("non-admin cannot access the admin review list", async () => {
    const res = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("cannot approve a week that hasn't been submitted", async () => {
    const res = await server.call("POST", `/api/admin/weeks/T1001/${week}/approve`, { userId: "ADMIN" });
    assert.equal(res.status, 409);
  });

  await t.test("approve locks a submitted week", async () => {
    const submit = await submitFullWeek(server, "T1001", week, "PRINCETON");
    assert.equal(submit.status, 200);

    const approve = await server.call("POST", `/api/admin/weeks/T1001/${week}/approve`, { userId: "ADMIN" });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.status, "approved");

    const detail = await server.call("GET", `/api/technicians/T1001/weeks/${week}`, { userId: "T1001" });
    assert.equal(detail.body.status, "approved");
    assert.equal(detail.body.locked, true);
  });

  await t.test("cannot approve the same week twice", async () => {
    const res = await server.call("POST", `/api/admin/weeks/T1001/${week}/approve`, { userId: "ADMIN" });
    assert.equal(res.status, 409);
  });

  await t.test("unlock returns an approved week to draft and editable", async () => {
    const unlock = await server.call("POST", `/api/admin/weeks/T1001/${week}/unlock`, { userId: "ADMIN" });
    assert.equal(unlock.status, 200);
    assert.equal(unlock.body.status, "draft");

    const edit = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [] },
    });
    assert.equal(edit.status, 200);
  });

  await t.test("reject returns a submitted week to the technician with a note", async () => {
    const submit = await submitFullWeek(server, "T1002", week, "GEORGETOWN");
    assert.equal(submit.status, 200);

    const reject = await server.call("POST", `/api/admin/weeks/T1002/${week}/reject`, {
      userId: "ADMIN",
      body: { note: "Wrong WOM, please redo." },
    });
    assert.equal(reject.status, 200);
    assert.equal(reject.body.status, "rejected");

    const detail = await server.call("GET", `/api/technicians/T1002/weeks/${week}`, { userId: "T1002" });
    assert.equal(detail.body.status, "rejected");
    assert.equal(detail.body.locked, false);
    assert.equal(detail.body.note, "Wrong WOM, please redo.");
  });

  await t.test("admin review list reflects current statuses and hour totals", async () => {
    const res = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const t1001 = res.body.find((r) => r.technician.id === "T1001");
    const t1002 = res.body.find((r) => r.technician.id === "T1002");
    assert.equal(t1001.status, "draft");
    assert.equal(t1002.status, "rejected");
    assert.equal(t1002.ukgHours, 37.5);
  });

  await t.test("admin can mark a week entered in UKG, independent of submit/approve status", async () => {
    const before = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "ADMIN" });
    const t1001Before = before.body.find((r) => r.technician.id === "T1001");
    assert.equal(t1001Before.ukgConfirmedAt, null);

    const nonAdmin = await server.call("PATCH", `/api/admin/weeks/T1001/${week}/ukg-confirmed`, {
      userId: "T1001",
      body: { confirmed: true },
    });
    assert.equal(nonAdmin.status, 403);

    const confirm = await server.call("PATCH", `/api/admin/weeks/T1001/${week}/ukg-confirmed`, {
      userId: "ADMIN",
      body: { confirmed: true },
    });
    assert.equal(confirm.status, 200);
    assert.ok(confirm.body.ukgConfirmedAt);

    const after = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "ADMIN" });
    const t1001After = after.body.find((r) => r.technician.id === "T1001");
    assert.ok(t1001After.ukgConfirmedAt);

    const undo = await server.call("PATCH", `/api/admin/weeks/T1001/${week}/ukg-confirmed`, {
      userId: "ADMIN",
      body: { confirmed: false },
    });
    assert.equal(undo.status, 200);
    assert.equal(undo.body.ukgConfirmedAt, null);
  });

  await t.test("overview flags overtime that isn't charged to a WOM", async () => {
    // T1003's seeded UKG hours for this week total 44h (Mon-Fri 8 + Sat 4) -- 4h of OT
    const put = await server.call("PUT", `/api/technicians/T1003/weeks/${week}/allocations`, {
      userId: "T1003",
      body: {
        allocations: ["Mon", "Tue", "Wed", "Thu", "Fri"]
          .map((day) => ({ day, type: "ef", locationCode: "CINCINNATI", hours: 8 }))
          .concat([{ day: "Sat", type: "ef", locationCode: "CINCINNATI", hours: 4 }]),
      },
    });
    assert.equal(put.status, 200);
    const submit = await server.call("POST", `/api/technicians/T1003/weeks/${week}/submit`, { userId: "T1003" });
    assert.equal(submit.status, 200);

    const overview = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "ADMIN" });
    const t1003 = overview.body.find((r) => r.technician.id === "T1003");
    assert.equal(t1003.otHours, 4);
    assert.equal(t1003.otOnWom, 0);
    assert.equal(t1003.otNotOnWom, 4);
    assert.equal(t1003.flagged, true);
  });

  await t.test("overtime charged to an open WOM is not flagged", async () => {
    const reject = await server.call("POST", `/api/admin/weeks/T1003/${week}/reject`, { userId: "ADMIN" });
    assert.equal(reject.status, 200);

    const createWom = await server.call("POST", "/api/woms", {
      userId: "ADMIN",
      body: { code: "WOM-9001", description: "Test overtime project", locationCode: "CINCINNATI" },
    });
    assert.equal(createWom.status, 201);

    const put = await server.call("PUT", `/api/technicians/T1003/weeks/${week}/allocations`, {
      userId: "T1003",
      body: {
        allocations: ["Mon", "Tue", "Wed", "Thu", "Fri"]
          .map((day) => ({ day, type: "ef", locationCode: "CINCINNATI", hours: 8 }))
          .concat([{ day: "Sat", type: "wom", locationCode: "CINCINNATI", womCode: "WOM-9001", hours: 4 }]),
      },
    });
    assert.equal(put.status, 200);
    const submit = await server.call("POST", `/api/technicians/T1003/weeks/${week}/submit`, { userId: "T1003" });
    assert.equal(submit.status, 200);

    const overview = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "ADMIN" });
    const t1003 = overview.body.find((r) => r.technician.id === "T1003");
    assert.equal(t1003.otHours, 4);
    assert.equal(t1003.otOnWom, 4);
    assert.equal(t1003.otNotOnWom, 0);
    assert.equal(t1003.flagged, false);
  });

  await t.test("admin can set a technician's per-day UKG hours", async () => {
    const res = await server.call("PUT", `/api/admin/weeks/T1003/${week}/ukg-hours`, {
      userId: "ADMIN",
      body: { hours: { Mon: 8, Tue: 8, Wed: 8, Thu: 7, Fri: 9, Sat: 0 } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ukgHoursByDay.Fri, 9);

    const detail = await server.call("GET", `/api/technicians/T1003/weeks/${week}`, { userId: "T1003" });
    assert.equal(detail.body.ukgTotal, 40);
  });

  await t.test("a technician cannot set UKG hours", async () => {
    const res = await server.call("PUT", `/api/admin/weeks/T1003/${week}/ukg-hours`, {
      userId: "T1003",
      body: { hours: { Mon: 8 } },
    });
    assert.equal(res.status, 403);
  });

  await t.test("rejects an invalid day or negative hours", async () => {
    const badDay = await server.call("PUT", `/api/admin/weeks/T1003/${week}/ukg-hours`, {
      userId: "ADMIN",
      body: { hours: { Someday: 8 } },
    });
    assert.equal(badDay.status, 400);

    const negative = await server.call("PUT", `/api/admin/weeks/T1003/${week}/ukg-hours`, {
      userId: "ADMIN",
      body: { hours: { Mon: -1 } },
    });
    assert.equal(negative.status, 400);
  });

  await t.test("admin can flag and clear a pending punch correction for a specific day", async () => {
    const flag = await server.call("PATCH", `/api/admin/weeks/T1003/${week}/pending-punch`, {
      userId: "ADMIN",
      body: { day: "Sat", flagged: true },
    });
    assert.equal(flag.status, 200);
    assert.equal(flag.body.pendingPunchByDay.Sat, true);

    const detail = await server.call("GET", `/api/technicians/T1003/weeks/${week}`, { userId: "T1003" });
    assert.equal(detail.body.pendingPunchByDay.Sat, true);
    // Flagging shouldn't disturb an already-set hours value for that day.
    assert.equal(detail.body.ukgHoursByDay.Sat, 0);

    const nonAdmin = await server.call("PATCH", `/api/admin/weeks/T1003/${week}/pending-punch`, {
      userId: "T1003",
      body: { day: "Sat", flagged: false },
    });
    assert.equal(nonAdmin.status, 403);

    const clear = await server.call("PATCH", `/api/admin/weeks/T1003/${week}/pending-punch`, {
      userId: "ADMIN",
      body: { day: "Sat", flagged: false },
    });
    assert.equal(clear.status, 200);
    assert.equal(clear.body.pendingPunchByDay.Sat, false);
  });

  await t.test("admin can set a technician's home location", async () => {
    const res = await server.call("PATCH", "/api/admin/technicians/T1003/home-location", {
      userId: "ADMIN",
      body: { locationCode: "PRINCETON" },
    });
    assert.equal(res.status, 200);

    const list = await server.call("GET", "/api/admin/technicians", { userId: "ADMIN" });
    const t1003 = list.body.find((t) => t.id === "T1003");
    assert.equal(t1003.homeLocationCode, "PRINCETON");
  });

  await t.test("rejects an unknown home location", async () => {
    const res = await server.call("PATCH", "/api/admin/technicians/T1003/home-location", {
      userId: "ADMIN",
      body: { locationCode: "NOPE" },
    });
    assert.equal(res.status, 400);
  });
});
