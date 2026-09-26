const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// Which role-buckets a viewer's own "unassigned but for my role" tasks can
// come from -- mirrors db.pseRoleFor's reviewer/financial split, but a
// viewer needs *all* roles they could ever be handed work under, not just
// the one that gates PSE actions specifically.
function rolesForViewer(user) {
  if (user.role !== "admin") return ["tech"];
  const reviewerId = db.getPseReviewerId();
  if (!reviewerId) return ["admin", "reviewer", "financial"];
  return user.id === reviewerId ? ["admin", "reviewer"] : ["admin", "financial"];
}

// Priority isn't purely manual -- an exception, an overdue due date, or a
// task that's simply been sitting open a long time should read as more
// urgent than its stored priority alone would suggest.
function computeTaskUrgency(t) {
  if (t.status === "completed" || t.status === "cancelled") return "done";
  // Emergency is a manual, top-of-everything call (an urgent PO, a hard
  // stop) -- it always reads as the strongest tier, never downgraded by
  // due date or age the way a merely-overdue task can still just be "urgent".
  if (t.priority === "emergency") return "emergency";
  const now = Date.now();
  const dueAt = t.due_at ? new Date(t.due_at).getTime() : null;
  const overdue = dueAt !== null && !Number.isNaN(dueAt) && dueAt < now;
  const ageDays = (now - new Date(t.created_at).getTime()) / 86400000;

  if (overdue || t.is_exception) return "urgent";
  if (t.priority === "urgent") return "urgent";
  if (t.priority === "high" || ageDays > 14) return "high";
  if (dueAt !== null && dueAt - now < 86400000) return "high"; // due within 24h
  if (t.priority === "low" && ageDays < 3) return "low";
  return "normal";
}

function presentTask(t) {
  const assignee = t.assigned_to ? db.findTechnician(t.assigned_to) : null;
  const vendor = t.related_vendor_id ? db.findVendor(t.related_vendor_id) : null;
  const location = t.related_location_code ? db.findLocation(t.related_location_code) : null;
  const wom = t.related_wom_code ? db.findWom(t.related_wom_code) : null;
  const now = Date.now();
  const ageMs = now - new Date(t.created_at).getTime();

  return {
    id: t.id,
    sourceKey: t.source_key,
    title: t.title,
    description: t.description,
    assignedTo: t.assigned_to,
    assignedToName: assignee ? assignee.name : null,
    assignedRole: t.assigned_role,
    category: t.category,
    priority: t.priority,
    dueAt: t.due_at,
    status: t.status,
    relatedWomCode: t.related_wom_code,
    relatedWomDescription: wom ? wom.description : null,
    relatedVendorId: t.related_vendor_id,
    relatedVendorName: vendor ? vendor.name : null,
    relatedLocationCode: t.related_location_code,
    relatedLocationName: location ? location.name : null,
    relatedTechId: t.related_tech_id,
    relatedPo: t.related_po,
    source: t.source,
    sourceRecordId: t.source_record_id,
    workflowRule: t.workflow_rule,
    isException: Boolean(t.is_exception),
    createdBy: t.created_by,
    createdAt: t.created_at,
    assignedAt: t.assigned_at,
    startedAt: t.started_at,
    completedAt: t.completed_at,
    lastStatusChangeAt: t.last_status_change_at,
    ageDays: Math.floor(ageMs / 86400000),
    urgency: computeTaskUrgency(t),
  };
}

// Every automated ("workflow"/"recurring") task is generated lazily on
// read rather than by any background scheduler -- see ensureRecurringTasks
// and syncPseStageTask in server/data/db.js. Calling this here means the
// board is always caught up whenever anyone opens it.
function catchUpTasks() {
  db.ensureRecurringTasks();
}

router.get("/", requireAuth, (req, res) => {
  catchUpTasks();
  const isAdmin = req.user.role === "admin";
  const roles = rolesForViewer(req.user);
  const view = req.query.view || "my";
  const filters = {};
  const nowIso = new Date().toISOString();

  const scopeToViewer = !isAdmin || view === "my";
  if (scopeToViewer) filters.forViewer = { id: req.user.id, roles };

  switch (view) {
    case "team":
      // Non-admins share one queue per role rather than seeing named
      // coworkers' individually-assigned tasks -- there's no crew/team
      // grouping in the data model yet, just the role split PSE already uses.
      if (!isAdmin) filters.assignedRole = roles.includes("tech") ? "tech" : roles[0];
      filters.status = db.OPEN_TASK_STATUSES;
      break;
    case "unassigned":
      if (!isAdmin) return res.status(403).json({ error: "Admin access required" });
      filters.unassignedOnly = true;
      filters.status = db.OPEN_TASK_STATUSES;
      break;
    case "overdue":
      filters.dueBefore = nowIso;
      filters.status = db.OPEN_TASK_STATUSES;
      break;
    case "waiting":
      filters.status = ["waiting"];
      break;
    case "exceptions":
      filters.isException = true;
      filters.status = db.OPEN_TASK_STATUSES;
      break;
    case "recurring":
      filters.category = "recurring";
      break;
    case "completed":
      filters.status = ["completed"];
      break;
    case "my":
    default:
      filters.status = db.OPEN_TASK_STATUSES;
      break;
  }

  // Cross-employee filtering is admin-only, per spec -- everyone else is
  // already pinned to their own identity/role above.
  if (isAdmin) {
    if (req.query.assignedTo) filters.assignedTo = req.query.assignedTo;
    if (req.query.role) filters.assignedRole = req.query.role;
    if (req.query.location) filters.relatedLocationCode = req.query.location;
    if (req.query.wom) filters.relatedWomCode = req.query.wom;
    if (req.query.vendor) filters.relatedVendorId = req.query.vendor;
    if (req.query.category) filters.category = req.query.category;
    if (req.query.dueDate) filters.dueOn = req.query.dueDate;
    if (req.query.status) filters.status = String(req.query.status).split(",");
  }

  res.json(db.listTasks(filters).map(presentTask));
});

router.get("/summary", requireAuth, (req, res) => {
  catchUpTasks();
  const isAdmin = req.user.role === "admin";
  const roles = rolesForViewer(req.user);
  const filters = { status: db.OPEN_TASK_STATUSES };
  if (!isAdmin) filters.forViewer = { id: req.user.id, roles };

  const openTasks = db.listTasks(filters);
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  res.json({
    dueToday: openTasks.filter((t) => t.due_at && t.due_at.slice(0, 10) === today).length,
    overdue: openTasks.filter((t) => t.due_at && new Date(t.due_at).getTime() < now).length,
    highPriority: openTasks.filter((t) => ["high", "urgent", "emergency"].includes(t.priority)).length,
    waiting: openTasks.filter((t) => t.status === "waiting").length,
    recurring: openTasks.filter((t) => t.category === "recurring").length,
    exceptions: openTasks.filter((t) => t.is_exception).length,
  });
});

function canSeeTask(user, task) {
  if (user.role === "admin") return true;
  const roles = rolesForViewer(user);
  return task.assigned_to === user.id || (!task.assigned_to && roles.includes(task.assigned_role));
}

router.get("/:id", requireAuth, (req, res) => {
  const task = db.findTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!canSeeTask(req.user, task)) return res.status(403).json({ error: "Not your task" });

  res.json({
    ...presentTask(task),
    comments: db.listTaskComments(task.id).map((c) => ({
      id: c.id,
      authorId: c.author_id,
      authorName: c.author_name,
      body: c.body,
      createdAt: c.created_at,
    })),
  });
});

router.post("/", requireAuth, (req, res) => {
  const isAdmin = req.user.role === "admin";
  const { title, description, priority, dueAt, category, relatedWomCode, relatedVendorId, relatedLocationCode, relatedTechId, relatedPo } =
    req.body || {};
  let { assignedTo, assignedRole } = req.body || {};
  if (!title) return res.status(400).json({ error: "title is required" });
  if (priority && !db.TASK_PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `priority must be one of: ${db.TASK_PRIORITIES.join(", ")}` });
  }
  if (relatedWomCode && !db.findWom(relatedWomCode)) return res.status(400).json({ error: `Unknown WOM: ${relatedWomCode}` });

  // A tech can hand themselves a follow-up but can't assign work to anyone
  // else or drop it into an admin/financial/reviewer queue.
  if (!isAdmin) {
    assignedTo = req.user.id;
    assignedRole = "tech";
  }

  const task = db.createTask({
    title,
    description,
    assignedTo: assignedTo || null,
    assignedRole: assignedRole || null,
    category: category || "manual",
    priority: priority || "normal",
    dueAt: dueAt || null,
    relatedWomCode: relatedWomCode || null,
    relatedVendorId: relatedVendorId || null,
    relatedLocationCode: relatedLocationCode || null,
    relatedTechId: relatedTechId || null,
    relatedPo: relatedPo || null,
    source: "manual",
    createdBy: req.user.id,
  });

  db.addAudit(req.user.id, "TASK_CREATED", `${req.user.name} created task: ${task.title}`);
  res.status(201).json(presentTask(task));
});

router.patch("/:id/status", requireAuth, (req, res) => {
  const task = db.findTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!canSeeTask(req.user, task)) return res.status(403).json({ error: "Not your task" });

  const { status } = req.body || {};
  if (!db.TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${db.TASK_STATUSES.join(", ")}` });
  }

  const updated = db.setTaskStatus(task.id, status);
  db.addAudit(
    req.user.id,
    status === "completed" ? "TASK_COMPLETED" : "TASK_STATUS_CHANGED",
    `${req.user.name} set task "${task.title}" to ${status}`
  );
  res.json(presentTask(updated));
});

router.patch("/:id/assign", requireAuth, requireAdmin, (req, res) => {
  const task = db.findTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: "Task not found" });

  const { assignedTo, assignedRole } = req.body || {};
  if (assignedTo && !db.findTechnician(assignedTo)) return res.status(400).json({ error: `Unknown employee: ${assignedTo}` });

  const updated = db.assignTask(task.id, { assignedTo, assignedRole });
  db.addAudit(
    req.user.id,
    "TASK_REASSIGNED",
    `${req.user.name} reassigned task "${task.title}" to ${assignedTo || assignedRole || "unassigned"}`
  );
  res.json(presentTask(updated));
});

router.post("/:id/comments", requireAuth, (req, res) => {
  const task = db.findTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!canSeeTask(req.user, task)) return res.status(403).json({ error: "Not your task" });

  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: "body is required" });

  const comments = db.addTaskComment(task.id, req.user.id, req.user.name, body.trim());
  res.status(201).json(comments.map((c) => ({ id: c.id, authorId: c.author_id, authorName: c.author_name, body: c.body, createdAt: c.created_at })));
});

module.exports = router;
