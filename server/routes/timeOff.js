const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

function canView(req, techId) {
  return req.user.role === "admin" || req.user.id === techId;
}

router.get("/types", (req, res) => {
  res.json(db.TIME_OFF_TYPES);
});

// ---- Policies (admin-managed) ----

router.get("/policies", requireAdmin, (req, res) => {
  res.json(db.listTimeOffPolicies());
});

router.post("/policies", requireAdmin, (req, res) => {
  try {
    const policy = db.createTimeOffPolicy(req.body || {});
    db.addAudit(req.user.id, "TIME_OFF_POLICY_CREATED", `${req.user.name} created the "${policy.name}" time-off policy`);
    res.status(201).json(policy);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/policies/:id", requireAdmin, (req, res) => {
  try {
    const updated = db.updateTimeOffPolicy(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Policy not found" });
    db.addAudit(req.user.id, "TIME_OFF_POLICY_UPDATED", `${req.user.name} updated the "${updated.name}" time-off policy`);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/policies/:id", requireAdmin, (req, res) => {
  const existing = db.findTimeOffPolicy(req.params.id);
  if (!existing) return res.status(404).json({ error: "Policy not found" });
  db.deleteTimeOffPolicy(req.params.id);
  db.addAudit(req.user.id, "TIME_OFF_POLICY_DELETED", `${req.user.name} deleted the "${existing.name}" time-off policy`);
  res.json({ ok: true });
});

router.patch("/technicians/:techId/policy", requireAdmin, (req, res) => {
  const { policyId } = req.body || {};
  const tech = db.setTechnicianTimeOffPolicy(req.params.techId, policyId || null);
  if (!tech) return res.status(404).json({ error: "Technician not found" });
  res.json(tech);
});

// ---- Approvers (admin-managed) ----

router.get("/approvers/:subjectId", requireAdmin, (req, res) => {
  res.json(db.listTimeOffApprovers(req.params.subjectId));
});

router.put("/approvers/:subjectId", requireAdmin, (req, res) => {
  const approverIds = Array.isArray(req.body?.approverIds) ? req.body.approverIds : [];
  res.json(db.setTimeOffApprovers(req.params.subjectId, approverIds));
});

// ---- Balance ----

router.get("/balance/:techId", (req, res) => {
  if (!canView(req, req.params.techId)) return res.status(403).json({ error: "Not allowed to view this balance" });
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
  res.json(db.computeTimeOffBalance(req.params.techId, year));
});

// ---- Requests ----

// Admin with no techId filter sees everything; a technician without one
// only ever sees their own (never silently returns the whole roster's
// requests to someone who didn't ask to see anyone else's).
router.get("/requests", (req, res) => {
  const { techId, status, from, to } = req.query || {};
  if (techId && !canView(req, techId)) return res.status(403).json({ error: "Not allowed to view these requests" });
  if (!techId && req.user.role !== "admin") {
    return res.json(db.listTimeOffRequests({ techId: req.user.id, status, from, to }));
  }
  res.json(db.listTimeOffRequests({ techId, status, from, to }));
});

// Requests this admin may actually act on -- every pending request whose
// subject lists them as an approver (or has no approvers configured,
// per the fallback -- see db.listTimeOffApprovers), excluding their own.
router.get("/approvals-queue", requireAdmin, (req, res) => {
  const pending = db.listTimeOffRequests({ status: "pending" });
  res.json(pending.filter((r) => db.canApproveTimeOff(req.user.id, r.techId)));
});

router.post("/requests", (req, res) => {
  const { techId, type, startDate, endDate, hoursPerDay, notes } = req.body || {};
  const targetTechId = techId || req.user.id;
  if (!canView(req, targetTechId)) return res.status(403).json({ error: "Not allowed to submit a request for this person" });
  try {
    const request = db.createTimeOffRequest(targetTechId, { type, startDate, endDate, hoursPerDay, notes });
    db.addAudit(req.user.id, "TIME_OFF_REQUESTED", `${req.user.name} requested ${db.TIME_OFF_TYPES.find((t) => t.value === type)?.label || type} for ${targetTechId} (${startDate} to ${endDate})`);
    res.status(201).json(request);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/requests/:id", (req, res) => {
  const { status, decisionNote } = req.body || {};
  try {
    const updated = db.decideTimeOffRequest(req.params.id, status, req.user.id, decisionNote);
    if (!updated) return res.status(404).json({ error: "Request not found" });
    db.addAudit(req.user.id, "TIME_OFF_DECIDED", `${req.user.name} set time-off request #${updated.id} (${updated.techId}) to ${status}`);
    res.json(updated);
  } catch (err) {
    res.status(err.message.includes("approver") ? 403 : 400).json({ error: err.message });
  }
});

module.exports = router;
