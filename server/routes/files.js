const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("../data/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Which upload categories make sense for which kind of record.
const CATEGORY_BY_RELATED = {
  week: new Set(["receipt", "ukg_screenshot"]),
  wom: new Set(["wom_doc"]),
  technician: new Set(["tech_form", "document"]),
  labor_report: new Set(["labor_report"]),
};

function parseWeekRelatedId(relatedId) {
  const [techId, weekMonday] = String(relatedId).split("|");
  return { techId, weekMonday };
}

function canRead(user, relatedType, relatedId) {
  if (user.role === "admin") return true;
  if (relatedType === "wom") return true;
  if (relatedType === "week") return parseWeekRelatedId(relatedId).techId === user.id;
  if (relatedType === "technician") return relatedId === user.id;
  return false;
}

// Technician forms/certifications are HR-adjacent and admin-managed; every
// other category can be attached by the technician who owns the record (or
// an admin).
function canWrite(user, relatedType, relatedId, category) {
  if (user.role === "admin") return true;
  if (category === "tech_form") return false;
  if (relatedType === "wom") return true;
  if (relatedType === "week") return parseWeekRelatedId(relatedId).techId === user.id;
  return false;
}

function relatedRecordExists(relatedType, relatedId) {
  if (relatedType === "wom") return Boolean(db.findWom(relatedId));
  if (relatedType === "technician") return Boolean(db.findTechnician(relatedId));
  if (relatedType === "week") return Boolean(db.findTechnician(parseWeekRelatedId(relatedId).techId));
  // Labor reports aren't tied to a record that already exists elsewhere --
  // they're just an admin-only monthly archive, keyed by "YYYY-MM".
  if (relatedType === "labor_report") return /^\d{4}-\d{2}$/.test(relatedId);
  return false;
}

router.get("/", requireAuth, (req, res) => {
  const { relatedType, relatedId } = req.query;
  if (!relatedType || !relatedId) {
    return res.status(400).json({ error: "relatedType and relatedId query params are required" });
  }
  if (!canRead(req.user, relatedType, relatedId)) return res.status(403).json({ error: "Not authorized" });
  res.json(db.listFiles(relatedType, relatedId));
});

router.post("/", requireAuth, upload.single("file"), (req, res) => {
  const { relatedType, relatedId, category, formType, expiresAt } = req.body || {};
  if (!req.file) return res.status(400).json({ error: "file is required" });
  if (!relatedType || !relatedId || !category) {
    return res.status(400).json({ error: "relatedType, relatedId, and category are required" });
  }

  const allowedCategories = CATEGORY_BY_RELATED[relatedType];
  if (!allowedCategories || !allowedCategories.has(category)) {
    return res.status(400).json({ error: `category "${category}" is not valid for relatedType "${relatedType}"` });
  }
  if (!relatedRecordExists(relatedType, relatedId)) {
    return res.status(404).json({ error: "Related record not found" });
  }
  if (!canWrite(req.user, relatedType, relatedId, category)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  if (expiresAt && !DATE_RE.test(expiresAt)) {
    return res.status(400).json({ error: "expiresAt must be a YYYY-MM-DD date" });
  }

  const id = crypto.randomUUID();
  const ext = path.extname(req.file.originalname || "").slice(0, 10);
  const storedName = `${id}${ext}`;
  fs.writeFileSync(path.join(db.UPLOADS_DIR, storedName), req.file.buffer);

  const record = db.insertFile({
    id,
    relatedType,
    relatedId,
    category,
    originalName: req.file.originalname,
    storedName,
    mimeType: req.file.mimetype,
    size: req.file.size,
    uploadedBy: req.user.id,
    uploadedAt: new Date().toISOString(),
    formType: formType || null,
    expiresAt: expiresAt || null,
  });

  db.addAudit(
    req.user.id,
    "FILE_UPLOADED",
    `${req.user.name} uploaded ${category} "${req.file.originalname}" to ${relatedType} ${relatedId}`
  );

  res.status(201).json(record);
});

router.get("/:id/download", requireAuth, (req, res) => {
  const file = db.getFile(req.params.id);
  if (!file) return res.status(404).json({ error: "File not found" });
  if (!canRead(req.user, file.relatedType, file.relatedId)) return res.status(403).json({ error: "Not authorized" });

  const filePath = path.join(db.UPLOADS_DIR, file.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File missing on disk" });

  const safeName = file.originalName.replace(/["\r\n]/g, "_");
  res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  fs.createReadStream(filePath).pipe(res);
});

// Deleting is admin-only, full stop -- even a technician deleting their own
// upload is disallowed, so nothing a technician can see ever has a delete
// path that isn't mediated by an admin.
router.delete("/:id", requireAuth, (req, res) => {
  const file = db.getFile(req.params.id);
  if (!file) return res.status(404).json({ error: "File not found" });
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Not authorized" });
  }

  db.deleteFile(file.id);
  const filePath = path.join(db.UPLOADS_DIR, file.storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.addAudit(req.user.id, "FILE_DELETED", `${req.user.name} deleted "${file.originalName}" from ${file.relatedType} ${file.relatedId}`);
  res.json({ ok: true });
});

module.exports = router;
