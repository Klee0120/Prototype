const test = require("node:test");
const assert = require("node:assert/strict");

const { fireKeyFor, currentPartsInTimezone, SYNC_TIMES, TIMEZONE } = require("../server/scheduler");

test("scheduler: fireKeyFor matches 8am/12pm/4pm Eastern on business days only", async (t) => {
  await t.test("fires at each configured time on a weekday, in winter (EST, UTC-5)", () => {
    // Monday Jan 5, 2026 is EST -- 08:00/12:00/16:00 ET = 13:00/17:00/21:00 UTC.
    assert.equal(fireKeyFor(new Date("2026-01-05T13:00:00.000Z")), "2026-01-05 08:00");
    assert.equal(fireKeyFor(new Date("2026-01-05T17:00:00.000Z")), "2026-01-05 12:00");
    assert.equal(fireKeyFor(new Date("2026-01-05T21:00:00.000Z")), "2026-01-05 16:00");
  });

  await t.test("fires correctly in summer too (EDT, UTC-4) -- the timezone conversion isn't hardcoded to one offset", () => {
    // Monday July 6, 2026 is EDT -- 08:00 ET = 12:00 UTC.
    assert.equal(fireKeyFor(new Date("2026-07-06T12:00:00.000Z")), "2026-07-06 08:00");
  });

  await t.test("does not fire a minute off from a configured time", () => {
    assert.equal(fireKeyFor(new Date("2026-01-05T13:01:00.000Z")), null);
    assert.equal(fireKeyFor(new Date("2026-01-05T12:59:00.000Z")), null);
  });

  await t.test("does not fire outside the three configured times at all", () => {
    assert.equal(fireKeyFor(new Date("2026-01-05T15:00:00.000Z")), null); // 10am ET
  });

  await t.test("never fires on a weekend", () => {
    // Saturday Jan 3, 2026, 08:00 ET.
    assert.equal(fireKeyFor(new Date("2026-01-03T13:00:00.000Z")), null);
    // Sunday Jan 4, 2026, 12:00 ET.
    assert.equal(fireKeyFor(new Date("2026-01-04T17:00:00.000Z")), null);
  });

  await t.test("fires on both the first and last business days of a week", () => {
    // Friday Jan 9, 2026, 16:00 ET.
    assert.equal(fireKeyFor(new Date("2026-01-09T21:00:00.000Z")), "2026-01-09 16:00");
  });
});

test("scheduler: currentPartsInTimezone reads the real wall clock in the given zone, not the server's own", () => {
  const parts = currentPartsInTimezone(new Date("2026-01-05T13:00:00.000Z"), "America/New_York");
  assert.equal(parts.weekday, "Mon");
  assert.equal(parts.hhmm, "08:00");
  assert.equal(parts.dateKey, "2026-01-05");
});

test("scheduler: configuration matches what Krista asked for", () => {
  assert.deepEqual(SYNC_TIMES, ["08:00", "12:00", "16:00"]);
  assert.equal(TIMEZONE, "America/New_York");
});
