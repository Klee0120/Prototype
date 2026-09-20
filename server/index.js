const express = require("express");
const path = require("path");

const { currentWeekMonday } = require("./utils/week");
const authRoutes = require("./routes/auth");
const technicianRoutes = require("./routes/technicians");
const womRoutes = require("./routes/woms");
const adminRoutes = require("./routes/admin");
const auditRoutes = require("./routes/audit");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/api/meta/current-week", (req, res) => {
  res.json({ weekMonday: currentWeekMonday() });
});

app.use("/api/auth", authRoutes);
app.use("/api/technicians", technicianRoutes);
app.use("/api/woms", womRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/audit", auditRoutes);

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, () => {
  console.log(`Labor allocation prototype running at http://localhost:${PORT}`);
});
