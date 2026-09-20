const express = require("express");
const db = require("../data/db");

const router = express.Router();

router.post("/login", (req, res) => {
  const { id, pin } = req.body || {};
  if (!id || !pin) return res.status(400).json({ error: "ID and PIN are required" });

  const user = db.verifyLogin(id, pin);
  if (!user) {
    return res.status(401).json({ error: "Invalid ID or PIN" });
  }

  db.addAudit(user.id, "LOGIN", `${user.name} logged in`);

  res.json({
    id: user.id,
    name: user.name,
    role: user.role,
  });
});

module.exports = router;
