const express = require("express");
const db = require("../data/db");
const { requireAuth } = require("../middleware/auth");
const { DAY_NAMES } = require("../utils/week");
const { presentAllocation } = require("../utils/allocation");

const router = express.Router();

const TIME_OFF_LABELS = { vacation: "Vacation", sick: "Sick", bereavement: "Bereavement", holiday: "Holiday" };

// Read-only "who's where this week" grid -- open to any logged-in user (not
// admin-only) since the whole point is letting anyone, tech or admin, see a
// teammate's already-committed work before assigning them something else,
// without a live Teams/Outlook connection (not built yet -- see README).
// Deliberately exposes only id/name/day assignments, not the rest of a
// technician's roster profile.
router.get("/:weekMonday", requireAuth, (req, res) => {
  const { weekMonday } = req.params;
  const locationByCode = Object.fromEntries(db.listLocations().map((l) => [l.code, l]));
  const womByCode = Object.fromEntries(db.listWoms().map((w) => [w.code, w]));

  const rows = db
    .listTechnicians()
    .filter((t) => t.employment_status === "active")
    .map((t) => {
      const week = db.getWeek(t.id, weekMonday);
      const days = Object.fromEntries(DAY_NAMES.map((d) => [d, []]));
      for (const raw of week.allocations) {
        const a = presentAllocation(raw);
        let label;
        if (a.type === "wom") {
          const w = womByCode[a.womCode];
          label = `${a.womCode}${w ? ` — ${w.description}` : ""}`;
        } else if (a.type === "ef") {
          const l = locationByCode[a.locationCode];
          label = l ? l.name : a.locationCode;
        } else {
          label = TIME_OFF_LABELS[a.timeOffType] || a.timeOffType;
        }
        days[a.day].push({ kind: a.type, label, hours: a.hours });
      }
      return { techId: t.id, techName: t.name, days };
    });

  res.json(rows);
});

module.exports = router;
