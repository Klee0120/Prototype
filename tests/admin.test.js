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

  await t.test("unlock also works on a merely-submitted (not yet approved) week", async () => {
    // This is the exact scenario that leaves a day mismatched: a week gets
    // submitted, then an admin corrects the technician's UKG hours
    // afterward -- the already-submitted allocation no longer matches, and
    // admin needs a way back in to fix it without first rejecting (which
    // would bounce it to the technician) or approving a now-wrong week.
    const submit = await submitFullWeek(server, "T1003", week, "CINCINNATI");
    assert.equal(submit.status, 200);

    const cannotEditWhileSubmitted = await server.call("PUT", `/api/technicians/T1003/weeks/${week}/allocations`, {
      userId: "ADMIN",
      body: { allocations: [] },
    });
    assert.equal(cannotEditWhileSubmitted.status, 409);

    const unlock = await server.call("POST", `/api/admin/weeks/T1003/${week}/unlock`, { userId: "ADMIN" });
    assert.equal(unlock.status, 200);
    assert.equal(unlock.body.status, "draft");

    const nowEditable = await server.call("PUT", `/api/technicians/T1003/weeks/${week}/allocations`, {
      userId: "ADMIN",
      body: { allocations: [] },
    });
    assert.equal(nowEditable.status, 200);
  });

  await t.test("unlock rejects a week that's still just a draft", async () => {
    const res = await server.call("POST", `/api/admin/weeks/T1003/${week}/unlock`, { userId: "ADMIN" });
    assert.equal(res.status, 409);
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

  await t.test("setting UKG hours for a technician opted into email notifications doesn't fail the request", async () => {
    const optIn = await server.call("PATCH", "/api/technicians/T1003/notification-pref", {
      userId: "T1003",
      body: { notificationPref: "email" },
    });
    assert.equal(optIn.status, 200);

    // SMTP isn't configured in tests, so this exercises the fire-and-forget
    // mailer.sendMail() call without actually sending anything -- the point
    // is that a missing/failed email never blocks the actual UKG-hours save.
    const res = await server.call("PUT", `/api/admin/weeks/T1003/${week}/ukg-hours`, {
      userId: "ADMIN",
      body: { hours: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 0 } },
    });
    assert.equal(res.status, 200);
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

  await t.test("ot-trends surfaces a technician flagged in the trailing window and excludes never-flagged ones", async () => {
    const setHours = await server.call("PUT", `/api/admin/weeks/T1001/${week}/ukg-hours`, {
      userId: "ADMIN",
      body: { hours: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 6 } },
    });
    assert.equal(setHours.status, 200);

    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: {
        allocations: ["Mon", "Tue", "Wed", "Thu", "Fri"]
          .map((day) => ({ day, type: "ef", locationCode: "CINCINNATI", hours: 8 }))
          .concat([{ day: "Sat", type: "ef", locationCode: "CINCINNATI", hours: 6 }]),
      },
    });
    assert.equal(put.status, 200);
    const submit = await server.call("POST", `/api/technicians/T1001/weeks/${week}/submit`, { userId: "T1001" });
    assert.equal(submit.status, 200);

    const trends = await server.call("GET", `/api/admin/ot-trends/${week}`, { userId: "ADMIN" });
    assert.equal(trends.status, 200);
    const t1001 = trends.body.find((t) => t.technician.id === "T1001");
    assert.ok(t1001, "T1001 should show up since flagged this week");
    assert.ok(t1001.flaggedCount >= 1);
    assert.equal(t1001.weeks.length, 8);
    assert.ok(["rising", "falling", "steady"].includes(t1001.trendDirection));
    assert.ok(!trends.body.some((t) => t.technician.id === "T1002"), "never-flagged technicians shouldn't be listed");

    const forbidden = await server.call("GET", `/api/admin/ot-trends/${week}`, { userId: "T1001" });
    assert.equal(forbidden.status, 403);
  });
});

test("weekend hours addendum: log Sat/Sun on a locked week without unlocking", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;

  await t.test("setup: submit and approve T1001's week", async () => {
    // Test files each get their own DB, but top-level tests within one file
    // share it -- T1001's week may already be submitted/approved/rejected
    // from the earlier test in this file. Unlock first (a no-op 409 if it's
    // already draft/rejected) so submit always starts from a clean slate.
    await server.call("POST", `/api/admin/weeks/T1001/${week}/unlock`, { userId: "ADMIN" });

    const submit = await submitFullWeek(server, "T1001", week, "PRINCETON");
    assert.equal(submit.status, 200);
    const approve = await server.call("POST", `/api/admin/weeks/T1001/${week}/approve`, { userId: "ADMIN" });
    assert.equal(approve.status, 200);
  });

  await t.test("rejects a payload that includes a weekday", async () => {
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/weekend-allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "ef", locationCode: "PRINCETON", hours: 8 }] },
    });
    assert.equal(res.status, 400);
  });

  await t.test("another technician cannot log weekend hours on someone else's week", async () => {
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/weekend-allocations`, {
      userId: "T1002",
      body: { allocations: [{ day: "Sat", type: "ef", locationCode: "PRINCETON", hours: 4 }] },
    });
    assert.equal(res.status, 403);
  });

  await t.test("technician can log Sat/Sun hours without unlocking, and it doesn't need to match UKG", async () => {
    // Deliberately doesn't match UKG (which is 0 for Sat/Sun here) -- the
    // tech just logs what they worked; matching UKG is admin's job at
    // review time, not a save-time gate here.
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/weekend-allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Sat", type: "ef", locationCode: "PRINCETON", hours: 5 }] },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.weekendAddendumAt);

    const detail = await server.call("GET", `/api/technicians/T1001/weeks/${week}`, { userId: "T1001" });
    assert.equal(detail.body.status, "approved");
    assert.ok(detail.body.weekendAddendumAt);
    const sat = detail.body.allocations.find((a) => a.day === "Sat");
    assert.ok(sat, "Sat allocation should have been saved");
    assert.equal(sat.hours, 5);

    // Mon-Fri stays exactly as already approved.
    const monday = detail.body.allocations.find((a) => a.day === "Mon");
    assert.equal(monday.locationCode, "PRINCETON");

    // Weekly Review's own data source (not just the technician's own week
    // detail) needs this too -- otherwise admin has no way to see the flag
    // from the screen they're actually looking at.
    const overview = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "ADMIN" });
    const t1001Row = overview.body.find((r) => r.technician.id === "T1001");
    assert.ok(t1001Row.weekendAddendumAt);
  });

  await t.test("admin can acknowledge the addendum, clearing the flag", async () => {
    const ack = await server.call("POST", `/api/admin/weeks/T1001/${week}/acknowledge-weekend`, { userId: "ADMIN" });
    assert.equal(ack.status, 200);

    const detail = await server.call("GET", `/api/technicians/T1001/weeks/${week}`, { userId: "T1001" });
    assert.equal(detail.body.weekendAddendumAt, null);
  });

  await t.test("acknowledging again with nothing pending is rejected", async () => {
    const res = await server.call("POST", `/api/admin/weeks/T1001/${week}/acknowledge-weekend`, { userId: "ADMIN" });
    assert.equal(res.status, 409);
  });

  await t.test("a technician cannot acknowledge (admin-only)", async () => {
    await server.call("PUT", `/api/technicians/T1001/weeks/${week}/weekend-allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Sun", type: "ef", locationCode: "PRINCETON", hours: 3 }] },
    });
    const res = await server.call("POST", `/api/admin/weeks/T1001/${week}/acknowledge-weekend`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("admin can adjust the weekend hours to match UKG, then acknowledge", async () => {
    const adjust = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/weekend-allocations`, {
      userId: "ADMIN",
      body: { allocations: [{ day: "Sun", type: "ef", locationCode: "PRINCETON", hours: 6 }] },
    });
    assert.equal(adjust.status, 200);

    const detail = await server.call("GET", `/api/technicians/T1001/weeks/${week}`, { userId: "T1001" });
    const sun = detail.body.allocations.find((a) => a.day === "Sun");
    assert.equal(sun.hours, 6);
    // Adjusting via this endpoint replaces just Sat/Sun -- the earlier Sat
    // row from a prior save is gone since this call's payload only included Sun.
    const sat = detail.body.allocations.find((a) => a.day === "Sat");
    assert.equal(sat, undefined);

    const ack = await server.call("POST", `/api/admin/weeks/T1001/${week}/acknowledge-weekend`, { userId: "ADMIN" });
    assert.equal(ack.status, 200);
  });

  await t.test("weekend-addenda list only shows weeks with a pending flag", async () => {
    const list = await server.call("GET", "/api/admin/weekend-addenda", { userId: "ADMIN" });
    assert.equal(list.status, 200);
    assert.ok(!list.body.some((a) => a.techId === "T1001" && a.weekMonday === week));

    const forbidden = await server.call("GET", "/api/admin/weekend-addenda", { userId: "T1001" });
    assert.equal(forbidden.status, 403);
  });
});

test("priorities: short-hours flag, missing UKG, report gaps, admin accounts", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;

  await t.test("a week short of 40 by more than 3 hours flags as short_hours (not ot_not_on_wom)", async () => {
    const setHours = await server.call("PUT", `/api/admin/weeks/T1002/${week}/ukg-hours`, {
      userId: "ADMIN",
      body: { hours: { Mon: 6, Tue: 6, Wed: 6, Thu: 6, Fri: 6, Sat: 0, Sun: 0 } },
    });
    assert.equal(setHours.status, 200);

    const put = await server.call("PUT", `/api/technicians/T1002/weeks/${week}/allocations`, {
      userId: "ADMIN",
      body: {
        allocations: ["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => ({ day, type: "ef", locationCode: "GEORGETOWN", hours: 6 })),
      },
    });
    assert.equal(put.status, 200);
    const submit = await server.call("POST", `/api/technicians/T1002/weeks/${week}/submit`, { userId: "ADMIN" });
    assert.equal(submit.status, 200);

    const overview = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "ADMIN" });
    const t1002 = overview.body.find((r) => r.technician.id === "T1002");
    assert.equal(t1002.ukgHours, 30);
    assert.equal(t1002.flagged, true);
    assert.equal(t1002.flagReason, "short_hours");

    // A short week must never pollute the OT-specific trend, which is
    // about a different concern (unexplained overtime, not a short week).
    const trends = await server.call("GET", `/api/admin/ot-trends/${week}`, { userId: "ADMIN" });
    assert.ok(!trends.body.some((t2) => t2.technician.id === "T1002"), "a short week shouldn't show up in OT trends");
  });

  await t.test("missing-ukg lists an active technician with zero UKG hours for the current week", async () => {
    const zeroOut = await server.call("PUT", `/api/admin/weeks/T1003/${week}/ukg-hours`, {
      userId: "ADMIN",
      body: { hours: { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 } },
    });
    assert.equal(zeroOut.status, 200);

    const missing = await server.call("GET", "/api/admin/missing-ukg", { userId: "ADMIN" });
    assert.equal(missing.status, 200);
    assert.ok(missing.body.some((r) => r.techId === "T1003"));
    // T1002 has hours entered (from the short-hours test above), so it
    // shouldn't show up here even though it's flagged for a different reason.
    assert.ok(!missing.body.some((r) => r.techId === "T1002"));

    const forbidden = await server.call("GET", "/api/admin/missing-ukg", { userId: "T1003" });
    assert.equal(forbidden.status, 403);
  });

  await t.test("report-gaps lists trailing months with no report, and drops a month once one's uploaded", async () => {
    const gaps = await server.call("GET", "/api/admin/report-gaps", { userId: "ADMIN" });
    assert.equal(gaps.status, 200);
    assert.equal(gaps.body.length, 3);

    const [gapMonth] = gaps.body;
    const upload = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "labor_report", relatedId: gapMonth, category: "labor_report" },
      fileName: "labor.xlsx",
      fileContent: "x",
    });
    assert.equal(upload.status, 201);

    const gapsAfter = await server.call("GET", "/api/admin/report-gaps", { userId: "ADMIN" });
    assert.ok(!gapsAfter.body.includes(gapMonth));
    assert.equal(gapsAfter.body.length, 2);
  });

  await t.test("admin can create a new admin account with its own login", async () => {
    const create = await server.call("POST", "/api/admin/admins", {
      userId: "ADMIN",
      body: { id: "ADMIN2", name: "Jordan Smith", pin: "4321" },
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.employmentStatus, "active");

    const login = await server.call("POST", "/api/auth/login", { body: { id: "ADMIN2", pin: "4321" } });
    assert.equal(login.status, 200);

    const list = await server.call("GET", "/api/admin/admins", { userId: "ADMIN" });
    assert.equal(list.status, 200);
    assert.ok(list.body.some((a) => a.id === "ADMIN2"));
  });

  await t.test("cannot create an admin account with an ID already in use", async () => {
    const res = await server.call("POST", "/api/admin/admins", {
      userId: "ADMIN",
      body: { id: "T1001", name: "Someone", pin: "1111" },
    });
    assert.equal(res.status, 409);
  });

  await t.test("an admin cannot deactivate their own account", async () => {
    const res = await server.call("PATCH", "/api/admin/admins/ADMIN/employment-status", {
      userId: "ADMIN",
      body: { status: "inactive" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("deactivating another admin's account blocks their login without touching audit history", async () => {
    const auditBefore = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const priorEntry = auditBefore.body.find((e) => e.action === "ADMIN_CREATED" && e.details.includes("Jordan Smith"));
    assert.ok(priorEntry, "expected the earlier ADMIN_CREATED entry to exist");

    const deactivate = await server.call("PATCH", "/api/admin/admins/ADMIN2/employment-status", {
      userId: "ADMIN",
      body: { status: "inactive" },
    });
    assert.equal(deactivate.status, 200);
    assert.equal(deactivate.body.employmentStatus, "inactive");

    const loginBlocked = await server.call("POST", "/api/auth/login", { body: { id: "ADMIN2", pin: "4321" } });
    assert.equal(loginBlocked.status, 401);

    // The account is deactivated, but the history of what it did while
    // active is untouched -- addAudit bakes the actor's name into the
    // details text at write time, not a live lookup.
    const auditAfter = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const stillThere = auditAfter.body.find((e) => e.action === "ADMIN_CREATED" && e.details.includes("Jordan Smith"));
    assert.ok(stillThere, "the original ADMIN_CREATED entry should still be there, untouched");
  });

  await t.test("a technician cannot manage admin accounts", async () => {
    const res = await server.call("GET", "/api/admin/admins", { userId: "T1001" });
    assert.equal(res.status, 403);
  });
});

test("purelyhr verification: time off flagged for manual cross-check", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;

  await t.test("a submitted week with time off shows hasTimeOff and no verification yet", async () => {
    await server.call("POST", `/api/admin/weeks/T1001/${week}/unlock`, { userId: "ADMIN" });

    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "ADMIN",
      body: {
        allocations: [
          { day: "Mon", type: "ef", locationCode: "PRINCETON", hours: 8 },
          { day: "Tue", type: "ef", locationCode: "PRINCETON", hours: 8 },
          { day: "Wed", type: "timeoff", timeOffType: "sick", hours: 8 },
          { day: "Thu", type: "ef", locationCode: "PRINCETON", hours: 8 },
          { day: "Fri", type: "ef", locationCode: "PRINCETON", hours: 8 },
        ],
      },
    });
    assert.equal(put.status, 200);
    const submit = await server.call("POST", `/api/technicians/T1001/weeks/${week}/submit`, { userId: "ADMIN" });
    assert.equal(submit.status, 200);

    const overview = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "ADMIN" });
    const t1001 = overview.body.find((r) => r.technician.id === "T1001");
    assert.equal(t1001.hasTimeOff, true);
    assert.equal(t1001.purelyhrVerifiedAt, null);
  });

  await t.test("shows up in the admin's unverified list with the time-off detail", async () => {
    const res = await server.call("GET", "/api/admin/purelyhr-unverified", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const entry = res.body.find((w) => w.techId === "T1001" && w.weekMonday === week);
    assert.ok(entry, "expected T1001's week in the unverified list");
    assert.ok(entry.timeOff.some((t) => t.timeOffType === "sick" && t.hours === 8 && t.day === "Wed"));

    const forbidden = await server.call("GET", "/api/admin/purelyhr-unverified", { userId: "T1001" });
    assert.equal(forbidden.status, 403);
  });

  await t.test("a technician cannot mark PurelyHR verification themselves", async () => {
    const res = await server.call("PATCH", `/api/admin/weeks/T1001/${week}/purelyhr-verified`, {
      userId: "T1001",
      body: { verified: true },
    });
    assert.equal(res.status, 403);
  });

  await t.test("admin marks it verified, and it drops off the unverified list", async () => {
    const res = await server.call("PATCH", `/api/admin/weeks/T1001/${week}/purelyhr-verified`, {
      userId: "ADMIN",
      body: { verified: true },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.purelyhrVerifiedAt);

    const list = await server.call("GET", "/api/admin/purelyhr-unverified", { userId: "ADMIN" });
    assert.ok(!list.body.some((w) => w.techId === "T1001" && w.weekMonday === week));

    const overview = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "ADMIN" });
    const t1001 = overview.body.find((r) => r.technician.id === "T1001");
    assert.ok(t1001.purelyhrVerifiedAt);
  });

  await t.test("undo clears it, putting the week back on the unverified list", async () => {
    const res = await server.call("PATCH", `/api/admin/weeks/T1001/${week}/purelyhr-verified`, {
      userId: "ADMIN",
      body: { verified: false },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.purelyhrVerifiedAt, null);

    const list = await server.call("GET", "/api/admin/purelyhr-unverified", { userId: "ADMIN" });
    assert.ok(list.body.some((w) => w.techId === "T1001" && w.weekMonday === week));
  });

  await t.test("editing the week's allocations clears an existing verification", async () => {
    const verify = await server.call("PATCH", `/api/admin/weeks/T1001/${week}/purelyhr-verified`, {
      userId: "ADMIN",
      body: { verified: true },
    });
    assert.ok(verify.body.purelyhrVerifiedAt);

    await server.call("POST", `/api/admin/weeks/T1001/${week}/unlock`, { userId: "ADMIN" });
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "ADMIN",
      body: {
        allocations: [
          { day: "Mon", type: "ef", locationCode: "PRINCETON", hours: 8 },
          { day: "Tue", type: "ef", locationCode: "PRINCETON", hours: 8 },
          { day: "Wed", type: "timeoff", timeOffType: "vacation", hours: 8 },
          { day: "Thu", type: "ef", locationCode: "PRINCETON", hours: 8 },
          { day: "Fri", type: "ef", locationCode: "PRINCETON", hours: 8 },
        ],
      },
    });
    assert.equal(put.status, 200);

    const overview = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "ADMIN" });
    const t1001 = overview.body.find((r) => r.technician.id === "T1001");
    assert.equal(t1001.purelyhrVerifiedAt, null);
  });

  await t.test("a week with no time off can't be verified", async () => {
    await server.call("POST", `/api/admin/weeks/T1002/${week}/unlock`, { userId: "ADMIN" });
    // T1002's UKG hours may carry residual values from an earlier test in
    // this file -- pin them so the allocation below is guaranteed to match.
    await server.call("PUT", `/api/admin/weeks/T1002/${week}/ukg-hours`, {
      userId: "ADMIN",
      body: { hours: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 0, Sun: 0 } },
    });
    const put = await server.call("PUT", `/api/technicians/T1002/weeks/${week}/allocations`, {
      userId: "ADMIN",
      body: {
        allocations: ["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => ({ day, type: "ef", locationCode: "GEORGETOWN", hours: 8 })),
      },
    });
    assert.equal(put.status, 200);
    const submit = await server.call("POST", `/api/technicians/T1002/weeks/${week}/submit`, { userId: "ADMIN" });
    assert.equal(submit.status, 200);

    const res = await server.call("PATCH", `/api/admin/weeks/T1002/${week}/purelyhr-verified`, {
      userId: "ADMIN",
      body: { verified: true },
    });
    assert.equal(res.status, 409);
  });

  await t.test("a draft week can't be verified even with time off entered", async () => {
    await server.call("POST", `/api/admin/weeks/T1001/${week}/unlock`, { userId: "ADMIN" });
    const res = await server.call("PATCH", `/api/admin/weeks/T1001/${week}/purelyhr-verified`, {
      userId: "ADMIN",
      body: { verified: true },
    });
    assert.equal(res.status, 409);
  });
});
