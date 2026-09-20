const { currentWeekMonday, shiftWeek } = require("../utils/week");

const thisWeek = currentWeekMonday();
const lastWeek = shiftWeek(thisWeek, -1);

function seed() {
  return {
    technicians: [
      { id: "T1001", name: "Alex Rivera", pin: "1234", role: "tech", active: true },
      { id: "T1002", name: "Jordan Lee", pin: "1234", role: "tech", active: true },
      { id: "T1003", name: "Sam Patel", pin: "2345", role: "tech", active: true },
      { id: "ADMIN", name: "Morgan Diaz", pin: "9999", role: "admin", active: true },
    ],

    woms: [
      { code: "WOM-4471", description: "HVAC Replacement - Bldg 3", status: "open" },
      { code: "WOM-4502", description: "Electrical Panel Upgrade - Bldg 7", status: "open" },
      { code: "WOM-4610", description: "Plumbing Repair - Cafeteria", status: "open" },
      { code: "WOM-4390", description: "Roof Repair - Bldg 1", status: "closed" },
      { code: "GEN-ADMIN", description: "General / Admin Time", status: "open" },
      { code: "PTO", description: "Paid Time Off", status: "open" },
    ],

    // UKG weekly total hours per technician per week (Monday key) — the source of truth.
    ukgHours: {
      [`T1001|${thisWeek}`]: 40,
      [`T1002|${thisWeek}`]: 37.5,
      [`T1003|${thisWeek}`]: 44,
      [`T1001|${lastWeek}`]: 40,
      [`T1002|${lastWeek}`]: 40,
      [`T1003|${lastWeek}`]: 32,
    },

    // Per-technician weekly allocation records, keyed by `${techId}|${weekMonday}`.
    weeks: {
      [`T1001|${lastWeek}`]: {
        status: "approved",
        allocations: [
          { day: "Mon", womCode: "WOM-4471", hours: 8 },
          { day: "Tue", womCode: "WOM-4471", hours: 8 },
          { day: "Wed", womCode: "WOM-4502", hours: 8 },
          { day: "Thu", womCode: "WOM-4502", hours: 8 },
          { day: "Fri", womCode: "GEN-ADMIN", hours: 8 },
        ],
        submittedAt: shiftWeek(thisWeek, 0) + "T09:00:00.000Z",
        reviewedAt: shiftWeek(thisWeek, 0) + "T14:00:00.000Z",
        reviewedBy: "ADMIN",
        note: "",
      },
      [`T1002|${lastWeek}`]: {
        status: "approved",
        allocations: [
          { day: "Mon", womCode: "WOM-4610", hours: 8 },
          { day: "Tue", womCode: "WOM-4610", hours: 8 },
          { day: "Wed", womCode: "WOM-4610", hours: 8 },
          { day: "Thu", womCode: "GEN-ADMIN", hours: 8 },
          { day: "Fri", womCode: "GEN-ADMIN", hours: 8 },
        ],
        submittedAt: shiftWeek(thisWeek, 0) + "T09:10:00.000Z",
        reviewedAt: shiftWeek(thisWeek, 0) + "T14:05:00.000Z",
        reviewedBy: "ADMIN",
        note: "",
      },
    },

    auditLog: [
      {
        id: 1,
        timestamp: shiftWeek(thisWeek, 0) + "T14:05:00.000Z",
        actor: "ADMIN",
        action: "WEEK_APPROVED",
        details: `Approved week ${lastWeek} for T1001`,
      },
      {
        id: 2,
        timestamp: shiftWeek(thisWeek, 0) + "T14:06:00.000Z",
        actor: "ADMIN",
        action: "WEEK_APPROVED",
        details: `Approved week ${lastWeek} for T1002`,
      },
    ],

    nextAuditId: 3,
  };
}

module.exports = { seed, thisWeek, lastWeek };
