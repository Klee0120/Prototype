const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { DAY_NAMES } = require("../utils/week");
const { presentAllocation } = require("../utils/allocation");
const { computeReceipt } = require("../utils/receipt");

const OT_NOT_ON_WOM_FLAG_THRESHOLD = 3;

const router = express.Router();
router.use(requireAuth, requireAdmin);

function round2(n) {
  return Math.round(n * 100) / 100;
}

function presentTechnician(t) {
  return {
    id: t.id,
    name: t.name,
    employmentStatus: t.employment_status,
    homeLocationCode: t.home_location_code,
    email: t.email,
    phone: t.phone,
    ukgId: t.ukg_id,
    position: t.position,
    hireDate: t.hire_date,
    terminationDate: t.termination_date,
    standardDailyHours: t.standard_daily_hours,
  };
}

router.get("/technicians", (req, res) => {
  res.json(db.listTechnicians().map(presentTechnician));
});

router.post("/technicians", (req, res) => {
  const { id, name, pin, homeLocationCode, email, phone, ukgId, position } = req.body || {};
  if (!id || !name || !pin) return res.status(400).json({ error: "id, name, and pin are required" });
  if (db.findTechnician(id)) return res.status(409).json({ error: "That ID is already in use" });
  if (homeLocationCode && !db.findLocation(homeLocationCode)) {
    return res.status(400).json({ error: `Unknown location: ${homeLocationCode}` });
  }

  const tech = db.createTechnician({ id, name, pin, homeLocationCode, email, phone, ukgId, position });
  db.addAudit(req.user.id, "TECHNICIAN_CREATED", `${req.user.name} added technician ${tech.name} (${tech.id})`);
  res.status(201).json(presentTechnician(tech));
});

router.get("/technicians/:id", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });
  res.json(presentTechnician(tech));
});

router.patch("/technicians/:id/home-location", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });

  const { locationCode } = req.body || {};
  if (locationCode && !db.findLocation(locationCode)) {
    return res.status(400).json({ error: `Unknown location: ${locationCode}` });
  }

  db.setHomeLocation(tech.id, locationCode || null);
  db.addAudit(req.user.id, "HOME_LOCATION_SET", `${req.user.name} set ${tech.name}'s home location to ${locationCode || "(none)"}`);
  res.json({ ok: true });
});

router.patch("/technicians/:id/employment-status", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });

  const { status } = req.body || {};
  if (!db.EMPLOYMENT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${db.EMPLOYMENT_STATUSES.join(", ")}` });
  }

  db.setEmploymentStatus(tech.id, status);
  db.addAudit(req.user.id, "TECH_STATUS_CHANGED", `${req.user.name} set ${tech.name}'s status to ${status}`);
  res.json(presentTechnician(db.findTechnician(tech.id)));
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.patch("/technicians/:id/basic-info", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });

  const { email, phone, ukgId, position, hireDate, terminationDate, standardDailyHours } = req.body || {};
  if (hireDate && !DATE_RE.test(hireDate)) return res.status(400).json({ error: "hireDate must be YYYY-MM-DD" });
  if (terminationDate && !DATE_RE.test(terminationDate)) {
    return res.status(400).json({ error: "terminationDate must be YYYY-MM-DD" });
  }
  if (standardDailyHours !== "" && standardDailyHours != null) {
    const n = Number(standardDailyHours);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "standardDailyHours must be a non-negative number" });
  }

  db.setTechnicianBasicInfo(tech.id, { email, phone, ukgId, position, hireDate, terminationDate, standardDailyHours });
  db.addAudit(req.user.id, "TECH_BASIC_INFO_UPDATED", `${req.user.name} updated ${tech.name}'s basic info`);
  res.json(presentTechnician(db.findTechnician(tech.id)));
});

router.get("/technicians/:id/history", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });
  res.json(db.getAllocationHistory(tech.id));
});

router.get("/technicians/:id/onboarding", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });
  res.json(db.getOnboardingProgress(tech.id));
});

router.patch("/technicians/:id/onboarding/:taskKey", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });
  if (!db.ONBOARDING_TASKS.some((t) => t.key === req.params.taskKey)) {
    return res.status(400).json({ error: "Unknown onboarding task" });
  }

  const completed = Boolean(req.body && req.body.completed);
  const progress = db.setOnboardingTask(tech.id, req.params.taskKey, completed);
  db.addAudit(
    req.user.id,
    "ONBOARDING_TASK_UPDATED",
    `${req.user.name} marked "${req.params.taskKey}" ${completed ? "complete" : "incomplete"} for ${tech.name}`
  );
  res.json(progress);
});

router.get("/technicians/:id/devices", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });
  res.json(db.listDevices(tech.id));
});

router.post("/technicians/:id/devices", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });

  const { deviceType, deviceName, notes } = req.body || {};
  if (!db.DEVICE_TYPES.includes(deviceType)) {
    return res.status(400).json({ error: `deviceType must be one of: ${db.DEVICE_TYPES.join(", ")}` });
  }
  if (!deviceName) return res.status(400).json({ error: deviceType === "phone" ? "Phone number is required" : "Identifier is required" });

  const devices = db.addDevice(tech.id, deviceType, deviceName, notes);
  db.addAudit(req.user.id, "DEVICE_ASSIGNED", `${req.user.name} assigned ${deviceType} "${deviceName}" to ${tech.name}`);
  res.status(201).json(devices);
});

router.delete("/technicians/:id/devices/:deviceId", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });

  const devices = db.removeDevice(tech.id, Number(req.params.deviceId));
  db.addAudit(req.user.id, "DEVICE_REMOVED", `${req.user.name} removed a device from ${tech.name}`);
  res.json(devices);
});

// Tracks an IT/vendor request against a device (Calero line cancellation,
// etc.) with a reference number to follow up on until it's marked done.
router.post("/technicians/:id/devices/:deviceId/requests", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });
  const device = db.findDevice(tech.id, Number(req.params.deviceId));
  if (!device) return res.status(404).json({ error: "Device not found" });

  const { requestType, referenceNumber } = req.body || {};
  if (!requestType) return res.status(400).json({ error: "requestType is required" });

  const requests = db.addDeviceRequest(device.id, requestType, referenceNumber);
  db.addAudit(
    req.user.id,
    "DEVICE_REQUEST_ADDED",
    `${req.user.name} logged a ${requestType} request${referenceNumber ? ` (#${referenceNumber})` : ""} for ${tech.name}'s device`
  );
  res.status(201).json(requests);
});

router.patch("/technicians/:id/devices/:deviceId/requests/:requestId", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });
  const device = db.findDevice(tech.id, Number(req.params.deviceId));
  if (!device) return res.status(404).json({ error: "Device not found" });

  // Editing the type/reference # and toggling completion are distinct
  // actions on the same request -- routed by which fields are present.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "requestType")) {
    const { requestType, referenceNumber } = req.body || {};
    if (!requestType) return res.status(400).json({ error: "requestType is required" });

    const requests = db.setDeviceRequestDetails(device.id, Number(req.params.requestId), { requestType, referenceNumber });
    db.addAudit(
      req.user.id,
      "DEVICE_REQUEST_UPDATED",
      `${req.user.name} updated a device request for ${tech.name} (${requestType}${referenceNumber ? ` #${referenceNumber}` : ""})`
    );
    return res.json(requests);
  }

  const completed = Boolean(req.body && req.body.completed);
  const requests = db.setDeviceRequestCompleted(device.id, Number(req.params.requestId), completed);
  db.addAudit(
    req.user.id,
    completed ? "DEVICE_REQUEST_COMPLETED" : "DEVICE_REQUEST_REOPENED",
    `${req.user.name} marked a device request ${completed ? "complete" : "not complete"} for ${tech.name}`
  );
  res.json(requests);
});

const FORM_EXPIRY_WARNING_DAYS = 30;

// Forms/certifications that are already expired or expiring soon, for the
// Overview tab's admin/RFM attention banner.
router.get("/expiring-forms", (req, res) => {
  res.json(db.listExpiringForms(FORM_EXPIRY_WARNING_DAYS));
});

router.get("/weeks/:weekMonday", (req, res) => {
  const { weekMonday } = req.params;
  const rows = db.listTechnicians().map((tech) => {
    const week = db.getWeek(tech.id, weekMonday);
    const ukgByDay = db.getUkgHoursByDay(tech.id, weekMonday);
    const ukgHours = round2(DAY_NAMES.reduce((sum, d) => sum + (ukgByDay[d] || 0), 0));
    const allocatedHours = round2(week.allocations.reduce((sum, a) => sum + Number(a.hours || 0), 0));
    const receipt = computeReceipt(week.allocations.map(presentAllocation));
    return {
      technician: { id: tech.id, name: tech.name, homeLocationCode: tech.home_location_code },
      status: week.status,
      ukgHours,
      allocatedHours,
      regularHours: receipt.regularTotal,
      otHours: receipt.otTotal,
      otOnWom: receipt.otFromWom,
      otNotOnWom: receipt.otFromEf,
      flagged: receipt.otFromEf > OT_NOT_ON_WOM_FLAG_THRESHOLD,
      submittedAt: week.submittedAt,
      reviewedAt: week.reviewedAt,
      reviewedBy: week.reviewedBy,
      note: week.note,
      ukgConfirmedAt: week.ukgConfirmedAt,
      ukgConfirmedBy: week.ukgConfirmedBy,
    };
  });
  res.json(rows);
});

// Admin's own three-step checklist for a technician's week: UKG hours
// entered, allocation split entered, and finally "I've put this into the
// real UKG system too" -- this last step is a manual flag independent of
// the technician's own submit/approve status (admin often drives all three
// steps directly, based on a conversation with the technician, without the
// technician ever touching the app themselves).
router.patch("/weeks/:techId/:weekMonday/ukg-confirmed", (req, res) => {
  const { techId, weekMonday } = req.params;
  const tech = db.findTechnician(techId);
  if (!tech) return res.status(404).json({ error: "Technician not found" });

  const confirmed = Boolean(req.body && req.body.confirmed);
  const week = db.setUkgConfirmed(techId, weekMonday, req.user.id, confirmed);
  db.addAudit(
    req.user.id,
    confirmed ? "UKG_ALLOCATION_CONFIRMED" : "UKG_ALLOCATION_UNCONFIRMED",
    `${req.user.name} marked ${tech.name}'s week ${weekMonday} as ${confirmed ? "" : "not "}entered in UKG`
  );
  res.json({ ok: true, ukgConfirmedAt: week.ukgConfirmedAt, ukgConfirmedBy: week.ukgConfirmedBy });
});

router.put("/weeks/:techId/:weekMonday/ukg-hours", (req, res) => {
  const { techId, weekMonday } = req.params;
  const tech = db.findTechnician(techId);
  if (!tech) return res.status(404).json({ error: "Technician not found" });

  const hours = req.body && req.body.hours;
  if (!hours || typeof hours !== "object") return res.status(400).json({ error: "hours object is required" });

  for (const [day, value] of Object.entries(hours)) {
    if (!DAY_NAMES.includes(day)) return res.status(400).json({ error: `Invalid day: ${day}` });
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `Invalid hours for ${day}` });
  }

  const updated = db.setUkgHours(techId, weekMonday, hours);
  const total = round2(DAY_NAMES.reduce((sum, d) => sum + (updated[d] || 0), 0));
  db.addAudit(req.user.id, "UKG_HOURS_SET", `${req.user.name} set UKG hours for ${tech.name}, week ${weekMonday} (${total}h total)`);

  res.json({ ok: true, ukgHoursByDay: updated });
});

// Flags a specific day as waiting on a real UKG punch correction (missed
// clock-out, etc.) so the technician sees why that day's hours aren't final
// yet, instead of it just looking forgotten or wrong.
router.patch("/weeks/:techId/:weekMonday/pending-punch", (req, res) => {
  const { techId, weekMonday } = req.params;
  const tech = db.findTechnician(techId);
  if (!tech) return res.status(404).json({ error: "Technician not found" });

  const { day, flagged } = req.body || {};
  if (!DAY_NAMES.includes(day)) return res.status(400).json({ error: `Invalid day: ${day}` });

  const updated = db.setPendingPunch(techId, weekMonday, day, Boolean(flagged));
  db.addAudit(
    req.user.id,
    flagged ? "PENDING_PUNCH_FLAGGED" : "PENDING_PUNCH_CLEARED",
    `${req.user.name} ${flagged ? "flagged" : "cleared"} a pending punch correction for ${tech.name}, ${day} of week ${weekMonday}`
  );
  res.json({ ok: true, pendingPunchByDay: updated });
});

router.post("/weeks/:techId/:weekMonday/approve", (req, res) => {
  const { techId, weekMonday } = req.params;
  const tech = db.findTechnician(techId);
  if (!tech) return res.status(404).json({ error: "Technician not found" });

  const week = db.getWeek(techId, weekMonday);
  if (week.status !== "submitted") {
    return res.status(409).json({ error: `Week must be submitted before it can be approved (currently ${week.status})` });
  }

  db.approveWeek(techId, weekMonday, req.user.id);
  db.addAudit(req.user.id, "WEEK_APPROVED", `${req.user.name} approved week ${weekMonday} for ${tech.name}`);
  res.json({ ok: true, status: "approved" });
});

router.post("/weeks/:techId/:weekMonday/reject", (req, res) => {
  const { techId, weekMonday } = req.params;
  const tech = db.findTechnician(techId);
  if (!tech) return res.status(404).json({ error: "Technician not found" });

  const week = db.getWeek(techId, weekMonday);
  if (week.status !== "submitted") {
    return res.status(409).json({ error: `Week must be submitted before it can be rejected (currently ${week.status})` });
  }

  const note = (req.body && req.body.note) || "";
  db.rejectWeek(techId, weekMonday, req.user.id, note);
  db.addAudit(req.user.id, "WEEK_REJECTED", `${req.user.name} rejected week ${weekMonday} for ${tech.name}${note ? `: ${note}` : ""}`);
  res.json({ ok: true, status: "rejected" });
});

router.post("/weeks/:techId/:weekMonday/unlock", (req, res) => {
  const { techId, weekMonday } = req.params;
  const tech = db.findTechnician(techId);
  if (!tech) return res.status(404).json({ error: "Technician not found" });

  const week = db.getWeek(techId, weekMonday);
  if (week.status !== "approved") {
    return res.status(409).json({ error: `Only an approved week can be unlocked (currently ${week.status})` });
  }

  db.unlockWeek(techId, weekMonday, req.user.id);
  db.addAudit(req.user.id, "WEEK_UNLOCKED", `${req.user.name} unlocked approved week ${weekMonday} for ${tech.name} for correction`);
  res.json({ ok: true, status: "draft" });
});

module.exports = router;
