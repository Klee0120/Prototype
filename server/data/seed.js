const { currentWeekMonday, shiftWeek } = require("../utils/week");

const thisWeek = currentWeekMonday();
const lastWeek = shiftWeek(thisWeek, -1);

function seed() {
  return {
    technicians: [
      { id: "T1001", name: "Alex Rivera", pin: "1234", role: "tech", active: 1 },
      { id: "T1002", name: "Jordan Lee", pin: "1234", role: "tech", active: 1 },
      { id: "T1003", name: "Sam Patel", pin: "2345", role: "tech", active: 1 },
      { id: "ADMIN", name: "Morgan Diaz", pin: "9999", role: "admin", active: 1 },
    ],

    woms: [
      { code: "WOM-4471", description: "HVAC Replacement - Bldg 3", status: "open" },
      { code: "WOM-4502", description: "Electrical Panel Upgrade - Bldg 7", status: "open" },
      { code: "WOM-4610", description: "Plumbing Repair - Cafeteria", status: "open" },
      { code: "WOM-4390", description: "Roof Repair - Bldg 1", status: "closed" },
      { code: "GEN-ADMIN", description: "General / Admin Time", status: "open" },
      { code: "PTO", description: "Paid Time Off", status: "open" },
    ],

    // UKG weekly total hours per technician per week — the source of truth.
    ukgHours: [
      { techId: "T1001", weekMonday: thisWeek, hours: 40 },
      { techId: "T1002", weekMonday: thisWeek, hours: 37.5 },
      { techId: "T1003", weekMonday: thisWeek, hours: 44 },
      { techId: "T1001", weekMonday: lastWeek, hours: 40 },
      { techId: "T1002", weekMonday: lastWeek, hours: 40 },
      { techId: "T1003", weekMonday: lastWeek, hours: 32 },
    ],

    weeks: [
      {
        techId: "T1001",
        weekMonday: lastWeek,
        status: "approved",
        allocations: [
          { day: "Mon", womCode: "WOM-4471", hours: 8 },
          { day: "Tue", womCode: "WOM-4471", hours: 8 },
          { day: "Wed", womCode: "WOM-4502", hours: 8 },
          { day: "Thu", womCode: "WOM-4502", hours: 8 },
          { day: "Fri", womCode: "GEN-ADMIN", hours: 8 },
        ],
        submittedAt: thisWeek + "T09:00:00.000Z",
        reviewedAt: thisWeek + "T14:00:00.000Z",
        reviewedBy: "ADMIN",
        note: "",
      },
      {
        techId: "T1002",
        weekMonday: lastWeek,
        status: "approved",
        allocations: [
          { day: "Mon", womCode: "WOM-4610", hours: 8 },
          { day: "Tue", womCode: "WOM-4610", hours: 8 },
          { day: "Wed", womCode: "WOM-4610", hours: 8 },
          { day: "Thu", womCode: "GEN-ADMIN", hours: 8 },
          { day: "Fri", womCode: "GEN-ADMIN", hours: 8 },
        ],
        submittedAt: thisWeek + "T09:10:00.000Z",
        reviewedAt: thisWeek + "T14:05:00.000Z",
        reviewedBy: "ADMIN",
        note: "",
      },
    ],

    auditLog: [
      {
        timestamp: thisWeek + "T14:05:00.000Z",
        actor: "ADMIN",
        action: "WEEK_APPROVED",
        details: `Approved week ${lastWeek} for T1001`,
      },
      {
        timestamp: thisWeek + "T14:06:00.000Z",
        actor: "ADMIN",
        action: "WEEK_APPROVED",
        details: `Approved week ${lastWeek} for T1002`,
      },
    ],
  };
}

module.exports = { seed, thisWeek, lastWeek };
