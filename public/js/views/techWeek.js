import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { DAY_NAMES, shiftWeek, weekRangeLabel } from "../weekUtil.js";
import { renderAttachments } from "./attachments.js";
import { renderWomPhotoPrompt } from "./womPhotoPrompt.js";

const STATUS_LABELS = {
  draft: "Draft",
  submitted: "Submitted — awaiting review",
  approved: "Approved & locked",
  rejected: "Returned — needs changes",
};

const TIME_OFF_OPTIONS = [
  { value: "vacation", label: "Vacation" },
  { value: "sick", label: "Sick" },
  { value: "bereavement", label: "Bereavement" },
  { value: "holiday", label: "Holiday" },
];

const WEEKEND_DAYS = ["Sat", "Sun"];
const REGULAR_DAY_NAMES = DAY_NAMES.filter((d) => !WEEKEND_DAYS.includes(d));

const WEEKLY_HOURS_TARGET = 40;
// Mirrors OT_NOT_ON_WOM_FLAG_THRESHOLD / the short-hours check in
// server/routes/admin.js -- same number, so what the technician sees here
// lines up with what actually gets flagged for RFM on the Overview tab.
const HOURS_CHECK_THRESHOLD = 3;

export async function renderTechWeek(container, techIdOverride) {
  const techId = techIdOverride || state.user.id;
  const [week, woms, locations] = await Promise.all([
    api.get(`/api/technicians/${techId}/weeks/${state.weekMonday}`),
    api.get("/api/woms"),
    api.get("/api/locations"),
  ]);

  // Working copy of allocations so rows can be edited locally before a save
  // round-trip.
  const allocations = week.allocations.map((a) => ({ ...a }));
  const womByCode = Object.fromEntries(woms.map((w) => [w.code, w]));
  const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
  const homeLocationCode = week.technician.homeLocationCode;

  // Default every day to a full E&F split at home up front, so the common
  // case (no WOM work that day) needs no clicks -- switch the type to WOM
  // Project on a row, or carve out hours into a new split, for the rest.
  // Only for days with nothing entered yet; never touches a day someone's
  // already started, and never runs outside full edit mode.
  if (week.editMode === "full" && homeLocationCode) {
    for (const day of DAY_NAMES) {
      const hasAnySplit = allocations.some((a) => a.day === day && a.type !== "timeoff");
      if (hasAnySplit) continue;
      const ukgActual = week.ukgHoursByDay[day] || 0;
      const already = allocations.filter((a) => a.day === day).reduce((s, a) => s + Number(a.hours || 0), 0);
      const remaining = round2(ukgActual - already);
      if (remaining > 0) {
        allocations.push({ day, type: "ef", locationCode: homeLocationCode, womCode: null, hours: remaining, _isAutoDefault: true });
      }
    }
  }

  let saveMessage = "";
  // Dismissible for this render session -- resets on remount (e.g. after
  // save/submit or navigating away and back), same as the old post-submit
  // version, but now shown *before* submit so there's still a Submit button
  // on screen while photos are being added instead of a dead end after.
  let photoPromptDismissed = false;
  // Each of these self-checks goes through up to three states for this
  // render session: "question" (shown), "acknowledged" (they confirmed it's
  // accurate -- shows the "RFM will be flagged" note), or "dismissed" (they
  // said they'll go fix the allocation instead, or clicked past the note).
  // Resets on remount same as the photo prompt above.
  let otCheckStage = "question";
  let shortCheckStage = "question";

  container.innerHTML = `<div id="tw-main"></div><div id="tw-attachments"></div>`;
  const main = container.querySelector("#tw-main");
  const attachmentsHost = container.querySelector("#tw-attachments");

  draw();
  renderAttachments(attachmentsHost, {
    title: "Attachments",
    relatedType: "week",
    relatedId: `${techId}|${state.weekMonday}`,
    categories: [
      { value: "ukg_screenshot", label: "UKG Timesheet Screenshot" },
      { value: "receipt", label: "Receipt / Invoice" },
    ],
    canUpload: true,
    emptyText: "No UKG screenshots or receipts attached yet.",
  });

  function openWomsAt(locationCode) {
    return woms.filter((w) => w.status === "open" && w.locationCode === locationCode);
  }

  function dayTotal(day) {
    return round2(allocations.filter((a) => a.day === day).reduce((s, a) => s + Number(a.hours || 0), 0));
  }

  // The auto-filled "default to home" row is a convenience guess, not a
  // deliberate choice -- clear it out the moment the user does something
  // that means it no longer applies (adds a real split, or marks the day
  // as time off), so it doesn't silently double-count alongside it.
  function clearAutoDefault(day) {
    for (let i = allocations.length - 1; i >= 0; i--) {
      if (allocations[i].day === day && allocations[i]._isAutoDefault) allocations.splice(i, 1);
    }
  }

  // Sat/Sun don't have to match UKG to submit -- a weekend callout is often
  // allocated before UKG has caught up, or worked in odd non-15-min punch
  // times admin will true up at approval. Same leniency as the weekend
  // addendum flow on an already-locked week; here it just means the normal
  // submit/approve path already covers it, so there's nothing extra a
  // technician needs to do differently for a weekend callout in an
  // still-open week.
  function canSubmitWeek() {
    if (week.locked) return false;
    return DAY_NAMES.filter((day) => day !== "Sat" && day !== "Sun").every(
      (day) => Math.abs(dayTotal(day) - (week.ukgHoursByDay[day] || 0)) < 0.01
    );
  }

  // Every edit re-renders the whole day-grid from scratch (see draw()), which
  // would otherwise yank focus (and the page's scroll position) out from
  // under someone mid-keystroke in an hours field. Tag the field being typed
  // into with a stable key, remember it and the cursor position right before
  // the rebuild, then re-find and refocus the matching field afterward
  // (preventScroll so the page doesn't jump) with the same cursor position.
  function captureFocusState() {
    const active = document.activeElement;
    if (!active || !main.contains(active) || !active.dataset.focusKey) return null;
    return {
      key: active.dataset.focusKey,
      // The exact text as typed so far -- restored verbatim below, so a
      // rebuild mid-keystroke (e.g. right after typing the "." in "5.07")
      // never gets overwritten back to the last fully-parsed number before
      // the rest of the digits are in.
      rawValue: active.value,
      selectionStart: typeof active.selectionStart === "number" ? active.selectionStart : null,
      selectionEnd: typeof active.selectionEnd === "number" ? active.selectionEnd : null,
    };
  }

  function restoreFocusState(saved) {
    if (!saved) return;
    const el = main.querySelector(`[data-focus-key="${saved.key}"]`);
    if (!el) return;
    if (saved.rawValue != null) el.value = saved.rawValue;
    el.focus({ preventScroll: true });
    if (saved.selectionStart != null) {
      try {
        el.setSelectionRange(saved.selectionStart, saved.selectionEnd);
      } catch {
        // Harmless to skip -- focus (and the value) are already restored.
      }
    }
  }

  function draw() {
    const focusState = captureFocusState();
    const mode = week.editMode || (week.locked ? "locked" : "full");
    const locked = mode === "locked";
    const timeOffOnly = mode === "timeoff-only";
    const weekAllocated = round2(allocations.reduce((s, a) => s + Number(a.hours || 0), 0));
    // Same two self-checks as the server's flagging in Overview: too much OT
    // not explained by any WOM project, or a week that came in well short of
    // 40 with nothing on file to explain the gap. UKG total (not allocated)
    // is the basis for the short check, same as the server -- 0 just means
    // nothing's been entered yet, not an actual short week.
    const receipt = computeReceipt(allocations);
    const otNotOnWomFlagged = receipt.otFromEf > HOURS_CHECK_THRESHOLD;
    const shortfall = round2(WEEKLY_HOURS_TARGET - week.ukgTotal);
    const shortHoursFlagged = week.ukgTotal > 0 && shortfall > HOURS_CHECK_THRESHOLD;
    // Once a week is submitted/approved, Sat/Sun stay open for a weekend
    // callout the tech gets asked to work after the fact -- logged via a
    // dedicated endpoint that never touches the already-locked Mon-Fri rows.
    const weekendEditable = locked;

    main.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="prev-week">&larr; Prev</button>
        <div class="week-range">${weekRangeLabel(state.weekMonday)}</div>
        <button class="btn btn-ghost" id="next-week">Next &rarr;</button>
      </div>

      <div class="ukg-banner">
        <div>
          <div class="ukg-label">UKG total hours (source of truth)</div>
          <div class="ukg-value">${week.ukgTotal}h</div>
        </div>
        <div>
          <div class="ukg-label">Allocated hours</div>
          <div class="ukg-value ${Math.abs(weekAllocated - week.ukgTotal) < 0.01 ? "ok" : "warn"}">${weekAllocated}h</div>
        </div>
      </div>

      <div class="status-banner status-${week.status}">
        <strong>${STATUS_LABELS[week.status]}</strong>
        ${week.status === "rejected" && week.note ? `<div class="status-note">Admin note: ${escapeHtml(week.note)}</div>` : ""}
        ${
          week.status === "approved" || week.status === "submitted"
            ? state.user.role === "admin"
              ? `<div class="status-note">This week is locked. <button class="btn btn-link unlock-week-btn" type="button">Unlock for correction</button></div>`
              : `<div class="status-note">This week is locked. Contact an admin to make corrections.</div>`
            : ""
        }
        ${locked && week.status === "draft" ? `<div class="status-note">The window to adjust this week has closed. Contact an admin if it needs correction.</div>` : ""}
        ${timeOffOnly ? `<div class="status-note">This week isn't open for full allocation yet -- you can enter time off in advance (vacation, sick, bereavement, holiday). Everything else opens up closer to the week itself.</div>` : ""}
        ${
          state.user.role !== "admin" && !locked && !timeOffOnly && week.status === "draft" && week.ukgTotal > 0
            ? `<div class="status-note ready-to-allocate">Your hours are in — go ahead and allocate your time below.</div>`
            : ""
        }
      </div>

      ${state.user.role !== "admin" ? renderNotificationPrefRow() : ""}

      ${
        weekendEditable
          ? `<div class="weekend-section">
              <div class="weekend-section-title">Weekend hours</div>
              <p class="weekend-section-hint">Called in after this week was already ${week.status}? Log Saturday/Sunday
                here — Mon-Fri below stays exactly as ${week.status}.</p>
              ${
                week.weekendAddendumAt
                  ? `<div class="weekend-addendum-note">
                      <strong>Weekend hours added</strong> since this week was ${week.status}.
                      ${
                        state.user.role === "admin"
                          ? "Accept these (and correct the hours if needed) from Weekly Review."
                          : "Your admin will review these and adjust them to match UKG's actual time."
                      }
                    </div>`
                  : ""
              }
              <div class="day-grid weekend-day-grid" id="weekend-day-grid"></div>
              <div class="action-row">
                <button class="btn btn-primary" id="save-weekend">Save weekend hours</button>
                <span class="save-message">${escapeHtml(saveMessage)}</span>
              </div>
            </div>`
          : ""
      }

      <div id="wom-photo-prompt-host"></div>
      <div id="hours-check-host"></div>

      <div class="day-grid" id="day-grid"></div>

      <div id="receipt-host"></div>

      ${
        locked
          ? ""
          : `
        <div class="action-row">
          <button class="btn btn-secondary" id="save-draft">Save draft</button>
          ${timeOffOnly ? "" : `<button class="btn btn-primary" id="submit-week" ${canSubmitWeek() ? "" : "disabled"}>Submit for review</button>`}
          <span class="save-message">${escapeHtml(saveMessage)}</span>
        </div>
      `
      }
    `;

    // Admins allocating on a technician's behalf don't need this nudge --
    // it's the technician's own reminder to document their WOM work, shown
    // up front (next to the Submit button) rather than as an after-the-fact
    // step with nothing left to do on screen.
    const womCodesWorked = [...new Set(allocations.filter((a) => a.type === "wom" && Number(a.hours) > 0).map((a) => a.womCode))];
    if (state.user.role !== "admin" && !photoPromptDismissed && womCodesWorked.length > 0) {
      main.querySelector("#wom-photo-prompt-host").appendChild(
        renderWomPhotoPrompt(womCodesWorked, () => {
          photoPromptDismissed = true;
          draw();
        })
      );
    }

    // Same self-checks as the server's Overview flagging, surfaced to the
    // technician themselves before they submit -- a nudge to double-check
    // (did RFM know about this? is there WOM time not yet reported?), not a
    // gate on submitting. Mutually exclusive by construction (one needs
    // >40h, the other <37h), so at most one shows at a time.
    const hoursCheckHost = main.querySelector("#hours-check-host");
    if (state.user.role !== "admin" && !locked && !timeOffOnly) {
      if (otNotOnWomFlagged && otCheckStage !== "dismissed") {
        hoursCheckHost.appendChild(
          renderHoursCheckPrompt(
            otCheckStage,
            `You have ${receipt.otFromEf}h of overtime this week that isn't charged to any WOM project. Was this approved by your RFM? Is there additional WOM time you haven't reported yet?`,
            () => {
              otCheckStage = "acknowledged";
              draw();
            },
            () => {
              otCheckStage = "dismissed";
              draw();
            }
          )
        );
      } else if (shortHoursFlagged && shortCheckStage !== "dismissed") {
        hoursCheckHost.appendChild(
          renderHoursCheckPrompt(
            shortCheckStage,
            `You're at ${week.ukgTotal}h this week, ${shortfall}h short of a full 40. If this was planned time off, submit PTO/Sick/Holiday for the difference. Did you arrange with your RFM to take these hours unpaid?`,
            () => {
              shortCheckStage = "acknowledged";
              draw();
            },
            () => {
              shortCheckStage = "dismissed";
              draw();
            }
          )
        );
      }
    }

    const grid = main.querySelector("#day-grid");
    // Once Sat/Sun move into their own dedicated weekend section (see below),
    // this grid is just the regular Mon-Fri week -- for a still-open week
    // (not weekendEditable), Sat/Sun stay here same as any other day.
    (weekendEditable ? REGULAR_DAY_NAMES : DAY_NAMES).forEach((day) => grid.appendChild(renderDayCard(day, mode, false)));
    if (weekendEditable) {
      const weekendGrid = main.querySelector("#weekend-day-grid");
      WEEKEND_DAYS.forEach((day) => weekendGrid.appendChild(renderDayCard(day, mode, true)));
    }
    if (!timeOffOnly) main.querySelector("#receipt-host").appendChild(renderReceipt());

    main.querySelector("#prev-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, -1);
      renderTechWeek(container, techIdOverride);
    });
    main.querySelector("#next-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, 1);
      renderTechWeek(container, techIdOverride);
    });

    const unlockBtn = main.querySelector(".unlock-week-btn");
    if (unlockBtn) {
      unlockBtn.addEventListener("click", async () => {
        unlockBtn.disabled = true;
        try {
          await api.post(`/api/admin/weeks/${techId}/${state.weekMonday}/unlock`);
          await renderTechWeek(container, techIdOverride);
        } catch (err) {
          unlockBtn.disabled = false;
          window.alert(`Could not unlock: ${err.message}`);
        }
      });
    }

    if (!locked) {
      main.querySelector("#save-draft").addEventListener("click", () => saveDraft());
      const submitBtn = main.querySelector("#submit-week");
      if (submitBtn) submitBtn.addEventListener("click", submit);
    }
    if (weekendEditable) {
      main.querySelector("#save-weekend").addEventListener("click", () => saveWeekendHours());
    }

    const prefSelect = main.querySelector(".notification-pref-select");
    if (prefSelect) {
      prefSelect.addEventListener("change", async (e) => {
        const pref = e.target.value;
        const msg = main.querySelector(".notification-pref-message");
        try {
          await api.patch(`/api/technicians/${techId}/notification-pref`, { notificationPref: pref });
          week.technician.notificationPref = pref;
          if (msg) msg.textContent = "Saved.";
        } catch (err) {
          e.target.value = week.technician.notificationPref || "in_app";
          if (msg) msg.textContent = err.message;
        }
      });
    }

    restoreFocusState(focusState);
  }

  // How the technician wants to hear "your hours are ready to allocate" --
  // in-app (the note above) always shows regardless; email is their own
  // opt-in on top of that, and only offered once they have an email on file
  // (set by an admin on their profile, not editable here).
  function renderNotificationPrefRow() {
    const pref = week.technician.notificationPref || "in_app";
    const hasEmail = Boolean(week.technician.email);
    return `
      <div class="notification-pref-row">
        <label>
          Notify me by
          <select class="notification-pref-select">
            <option value="in_app" ${pref === "in_app" ? "selected" : ""}>In-app only</option>
            <option value="email" ${pref === "email" ? "selected" : ""} ${hasEmail ? "" : "disabled"}>Email${hasEmail ? "" : " (ask admin to add your email first)"}</option>
          </select>
        </label>
        <span class="save-message notification-pref-message"></span>
      </div>
    `;
  }

  function renderDayCard(day, mode, weekendEditable) {
    const isWeekendDay = day === "Sat" || day === "Sun";
    // A locked week still opens Sat/Sun back up for a weekend-callout
    // addendum -- Mon-Fri (and non-weekend-editable weeks) stay fully locked.
    const dayReopened = weekendEditable && isWeekendDay;
    const locked = mode === "locked" && !dayReopened;
    const full = mode === "full" || dayReopened;
    const timeOffOnly = mode === "timeoff-only";
    const card = document.createElement("div");
    card.className = "day-card";
    const ukgActual = week.ukgHoursByDay[day] || 0;
    const pendingPunch = Boolean(week.pendingPunchByDay && week.pendingPunchByDay[day]);
    const pendingPunchDetail = (week.pendingPunchDetailByDay && week.pendingPunchDetailByDay[day]) || null;
    const splits = allocations.filter((a) => a.day === day && a.type !== "timeoff");
    const timeOff = allocations.find((a) => a.day === day && a.type === "timeoff") || null;
    const total = dayTotal(day);
    const delta = round2(total - ukgActual);
    const remaining = round2(ukgActual - total);

    card.innerHTML = `
      <div class="day-card-header">
        <span class="day-name">${day}${dayReopened ? ` <span class="badge badge-draft">Weekend entry</span>` : ""}</span>
        <span class="day-ukg-actual">UKG ACTUAL: <strong>${ukgActual}h</strong></span>
      </div>
      ${
        pendingPunch
          ? `<p class="pending-punch-note">⚠ ${
              pendingPunchDetail && pendingPunchDetail.reportedBy === "tech"
                ? `You reported a punch issue for this day${
                    pendingPunchDetail.note ? `: "${escapeHtml(pendingPunchDetail.note)}"` : ""
                  } — waiting on admin to fix it in UKG.`
                : "Pending punch correction in UKG — this day's hours aren't final yet."
            }</p>`
          : state.user.role !== "admin"
          ? `<div class="report-punch-host" data-day="${day}"></div>`
          : ""
      }
      ${timeOffOnly ? "" : `<div class="day-rows"></div>`}
      ${full ? `
        <div class="day-actions">
          <button class="btn btn-link add-split" type="button">+ Add split</button>
          <button class="btn btn-link default-home" type="button" ${homeLocationCode ? "" : "disabled"}>
            Default to home — ${homeLocationCode ? remaining : "0.00"} hrs
          </button>
        </div>
      `: ""}
      ${timeOffOnly ? "" : `
        <div class="day-balance">
          <span class="balance-pill ${Math.abs(delta) < 0.01 ? "ok" : "warn"}">
            ${Math.abs(delta) < 0.01 ? "● Balanced" : `● Off by ${Math.abs(delta)}`}
          </span>
        </div>
      `}
      ${locked ? "" : `<div class="time-off-row"></div>`}
    `;

    if (!timeOffOnly) {
      const rowsEl = card.querySelector(".day-rows");
      if (splits.length === 0) {
        const empty = document.createElement("div");
        empty.className = "day-row-empty";
        empty.textContent = locked ? "No hours logged." : "Not yet allocated.";
        rowsEl.appendChild(empty);
      }
      splits.forEach((row) => rowsEl.appendChild(renderSplitRow(row, locked)));

      if (timeOff && locked) {
        const label = TIME_OFF_OPTIONS.find((o) => o.value === timeOff.timeOffType)?.label || timeOff.timeOffType;
        const row = document.createElement("div");
        row.className = "day-row";
        row.innerHTML = `<span class="row-wom">Time off — ${escapeHtml(label)}</span><span class="row-hours">${timeOff.hours}h</span>`;
        rowsEl.appendChild(row);
      }
    }

    const reportPunchHost = card.querySelector(".report-punch-host");
    if (reportPunchHost) wireReportPunchHost(reportPunchHost, day);

    if (full) {
      card.querySelector(".add-split").addEventListener("click", () => {
        // Adding a real split means the auto-filled "everything is home
        // time" guess no longer applies -- clear it so it doesn't sit
        // there stacking hours on top of whatever gets added.
        clearAutoDefault(day);
        const locationCode = homeLocationCode || (locations[0] && locations[0].code) || "";
        allocations.push({ day, type: "ef", locationCode, womCode: null, hours: 0 });
        draw();
      });
      card.querySelector(".default-home").addEventListener("click", () => {
        if (!homeLocationCode) return;
        // "Default to home" means "everything today was worked at home" --
        // clear any WOM/other-location splits for this day (time off is
        // left alone) and set home E&F to whatever's left after that.
        for (let i = allocations.length - 1; i >= 0; i--) {
          const a = allocations[i];
          if (a.day !== day || a.type === "timeoff") continue;
          if (a.type === "ef" && a.locationCode === homeLocationCode) continue;
          allocations.splice(i, 1);
        }
        const afterClear = round2(ukgActual - dayTotal(day));
        if (afterClear <= 0) {
          draw();
          return;
        }
        const existingHome = allocations.find(
          (a) => a.day === day && a.type === "ef" && a.locationCode === homeLocationCode
        );
        if (existingHome) existingHome.hours = afterClear;
        else allocations.push({ day, type: "ef", locationCode: homeLocationCode, womCode: null, hours: afterClear });
        draw();
      });
    }

    if (!locked) {
      const timeOffHost = card.querySelector(".time-off-row");
      timeOffHost.appendChild(renderTimeOffRow(day, timeOff, ukgActual));
    }

    return card;
  }

  function renderSplitRow(row, locked) {
    const idx = allocations.indexOf(row);
    const rowEl = document.createElement("div");
    rowEl.className = "split-row";

    if (locked) {
      const label =
        row.type === "wom"
          ? `${row.womCode} — ${womByCode[row.womCode] ? womByCode[row.womCode].description : ""}`
          : `E&F — ${locationByCode[row.locationCode] ? locationByCode[row.locationCode].name : row.locationCode}`;
      rowEl.className = "day-row";
      rowEl.innerHTML = `<span class="row-wom">${escapeHtml(label)}</span><span class="row-hours">${row.hours}h</span>`;
      return rowEl;
    }

    const locationOptions = locations
      .map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === row.locationCode ? "selected" : ""}>${escapeHtml(l.name)}${l.code === homeLocationCode ? " (home)" : ""}</option>`)
      .join("");

    const womOptionsForLocation = openWomsAt(row.locationCode);
    let womOptions = womOptionsForLocation
      .map((w) => {
        const remainingLabel = w.remainingHours == null ? "" : ` (${w.remainingHours}h left)`;
        return `<option value="${escapeHtml(w.code)}" ${w.code === row.womCode ? "selected" : ""}>${escapeHtml(w.code)} — ${escapeHtml(w.description)}${remainingLabel}</option>`;
      })
      .join("");
    // If this row's saved WOM isn't in the open list (someone closed/invoiced
    // it after it was picked), the <select> would otherwise silently default
    // to whatever option happens to come first -- showing the tech a WOM
    // that isn't actually what's saved. Keep the real one visible (clearly
    // marked, not selectable-again) so the dropdown never lies about state;
    // they still have to explicitly pick a different, open WOM to fix it.
    const womIsStale = row.type === "wom" && row.womCode && !womOptionsForLocation.some((w) => w.code === row.womCode);
    if (womIsStale) {
      const staleWom = womByCode[row.womCode];
      const staleLabel = staleWom ? `${row.womCode} — ${staleWom.description} (closed — choose another)` : `${row.womCode} (no longer available — choose another)`;
      womOptions = `<option value="${escapeHtml(row.womCode)}" selected disabled>${escapeHtml(staleLabel)}</option>` + womOptions;
    }

    rowEl.innerHTML = `
      <div class="split-row-fields">
        <select class="split-type-select">
          <option value="ef" ${row.type === "ef" ? "selected" : ""}>E&amp;F — Location</option>
          <option value="wom" ${row.type === "wom" ? "selected" : ""}>WOM Project</option>
        </select>
        <select class="split-location-select">${locationOptions}</select>
        ${row.type === "wom" ? `<select class="split-wom-select">${womOptions || `<option value="">No open WOMs at this location</option>`}</select>` : ""}
        <input class="split-hours-input" type="text" inputmode="decimal" value="${row.hours}" data-focus-key="split-hours:${idx}" />
        <button class="btn btn-icon remove-split" type="button" aria-label="Remove split">&times;</button>
      </div>
      ${womIsStale ? `<p class="split-row-warning">This WOM is no longer open -- pick a different one before you can submit.</p>` : ""}
      ${
        row.type === "wom" && row.womCode && !womIsStale
          ? row._markComplete
            ? `<span class="mark-complete-pending">Will mark ${escapeHtml(row.womCode)} complete after you submit.</span> <button class="btn btn-link undo-complete-btn" type="button">Undo</button>`
            : `<button class="btn btn-link mark-complete-btn" type="button">Mark this WOM project complete</button>`
          : ""
      }
    `;

    rowEl.querySelector(".split-type-select").addEventListener("change", (e) => {
      delete allocations[idx]._isAutoDefault; // a deliberate edit now, not the auto-guess
      allocations[idx].type = e.target.value;
      if (e.target.value === "wom") {
        const firstOpen = openWomsAt(allocations[idx].locationCode)[0];
        allocations[idx].womCode = firstOpen ? firstOpen.code : null;
      } else {
        allocations[idx].womCode = null;
      }
      draw();
    });
    rowEl.querySelector(".split-location-select").addEventListener("change", (e) => {
      delete allocations[idx]._isAutoDefault;
      allocations[idx].locationCode = e.target.value;
      if (allocations[idx].type === "wom") {
        const firstOpen = openWomsAt(e.target.value)[0];
        allocations[idx].womCode = firstOpen ? firstOpen.code : null;
      }
      draw();
    });
    const womSelect = rowEl.querySelector(".split-wom-select");
    if (womSelect) {
      womSelect.addEventListener("change", (e) => {
        delete allocations[idx]._isAutoDefault;
        allocations[idx].womCode = e.target.value;
        draw();
      });
    }
    const hoursInput = rowEl.querySelector(".split-hours-input");
    hoursInput.addEventListener("input", (e) => {
      delete allocations[idx]._isAutoDefault;
      allocations[idx].hours = parseHoursInput(e.target.value, allocations[idx].hours);
      draw();
    });
    // Grab the whole value on focus so typing (or a paste) overwrites it
    // outright, instead of inserting into wherever the cursor happens to land.
    hoursInput.addEventListener("focus", (e) => e.target.select());
    // Once they're done with the field, snap its text back to the clean
    // parsed number (e.g. a stray trailing "." or leading zeros) -- this
    // field is otherwise never re-rendered from state while it's focused.
    hoursInput.addEventListener("blur", () => draw());
    rowEl.querySelector(".remove-split").addEventListener("click", () => {
      allocations.splice(idx, 1);
      draw();
    });
    const markComplete = rowEl.querySelector(".mark-complete-btn");
    if (markComplete) {
      markComplete.addEventListener("click", () => {
        if (!window.confirm(`Mark ${row.womCode} complete once this week is submitted? It will close for everyone at that point.`)) return;
        allocations[idx]._markComplete = true;
        draw();
      });
    }
    const undoComplete = rowEl.querySelector(".undo-complete-btn");
    if (undoComplete) {
      undoComplete.addEventListener("click", () => {
        allocations[idx]._markComplete = false;
        draw();
      });
    }

    return rowEl;
  }

  function renderTimeOffRow(day, timeOff, ukgActual) {
    const wrap = document.createElement("div");
    wrap.className = "time-off-field";
    const options = [`<option value="">None</option>`]
      .concat(TIME_OFF_OPTIONS.map((o) => `<option value="${o.value}" ${timeOff && timeOff.timeOffType === o.value ? "selected" : ""}>${o.label}</option>`))
      .join("");

    wrap.innerHTML = `
      <label class="time-off-label">Time off</label>
      <select class="time-off-select">${options}</select>
      <input class="time-off-hours-input" type="text" inputmode="decimal" value="${timeOff ? timeOff.hours : ""}" data-focus-key="timeoff-hours:${day}" ${timeOff ? "" : "disabled"} />
    `;

    wrap.querySelector(".time-off-select").addEventListener("change", (e) => {
      if (e.target.value) {
        // A real time-off selection means the day (or part of it) wasn't
        // worked -- clear the auto-filled "everything is home time" guess.
        clearAutoDefault(day);
      }
      const existingIdx = allocations.findIndex((a) => a.day === day && a.type === "timeoff");
      if (!e.target.value) {
        if (existingIdx !== -1) allocations.splice(existingIdx, 1);
      } else if (existingIdx !== -1) {
        allocations[existingIdx].timeOffType = e.target.value;
      } else {
        // Default to the day's full UKG hours -- matches the common case
        // (a full day off) so it balances immediately without more typing.
        allocations.push({ day, type: "timeoff", timeOffType: e.target.value, hours: ukgActual || 8 });
      }
      draw();
    });
    const timeOffHoursInput = wrap.querySelector(".time-off-hours-input");
    timeOffHoursInput.addEventListener("input", (e) => {
      const existingIdx = allocations.findIndex((a) => a.day === day && a.type === "timeoff");
      if (existingIdx !== -1) {
        allocations[existingIdx].hours = parseHoursInput(e.target.value, allocations[existingIdx].hours);
      }
      draw();
    });
    timeOffHoursInput.addEventListener("focus", (e) => e.target.select());
    timeOffHoursInput.addEventListener("blur", () => draw());

    return wrap;
  }

  function renderReceipt() {
    const receipt = computeReceipt(allocations);
    const bucketLabel = (b) => {
      if (b.kind === "wom") {
        const wom = womByCode[b.code];
        return `${b.code}${wom ? ` — ${wom.description}` : ""}`;
      }
      if (b.kind === "ef") {
        const loc = locationByCode[b.code];
        return `E&F — ${loc ? loc.name : b.code}`;
      }
      const label = TIME_OFF_OPTIONS.find((o) => o.value === b.code)?.label || b.code;
      return `Time off — ${label}`;
    };

    const wrap = document.createElement("div");
    wrap.className = "receipt-panel";
    wrap.innerHTML = `
      <div class="receipt-title">Weekly Receipt — Reg / OT Breakdown</div>
      <div class="receipt-tiles">
        <div class="receipt-tile"><span class="receipt-tile-label">Week Total (Worked)</span><span class="receipt-tile-value">${receipt.totalWorked}</span></div>
        <div class="receipt-tile"><span class="receipt-tile-label">Regular</span><span class="receipt-tile-value ok">${receipt.regularTotal}</span></div>
        <div class="receipt-tile"><span class="receipt-tile-label">Overtime</span><span class="receipt-tile-value warn">${receipt.otTotal}</span></div>
        <div class="receipt-tile"><span class="receipt-tile-label">OT on WOM</span><span class="receipt-tile-value warn">${receipt.otFromWom}</span></div>
        <div class="receipt-tile"><span class="receipt-tile-label">OT not on WOM</span><span class="receipt-tile-value ${receipt.otFromEf > 3 ? "danger" : "warn"}">${receipt.otFromEf}</span></div>
        <div class="receipt-tile"><span class="receipt-tile-label">Time Off</span><span class="receipt-tile-value">${receipt.totalTimeOff}</span></div>
      </div>
      ${
        receipt.buckets.length === 0
          ? ""
          : `<table class="detail-table receipt-table">
              <thead><tr><th>Bucket</th><th>Type</th><th>Reg</th><th>OT</th><th>Total</th></tr></thead>
              <tbody>
                ${receipt.buckets
                  .map(
                    (b) => `<tr><td>${escapeHtml(bucketLabel(b))}</td><td>${b.kind.toUpperCase()}</td><td>${b.reg}</td><td>${b.ot}</td><td>${b.hours}</td></tr>`
                  )
                  .join("")}
                <tr class="receipt-total-row"><td colspan="2">Total</td><td>${receipt.regularTotal}</td><td>${receipt.otTotal}</td><td>${round2(receipt.regularTotal + receipt.otTotal)}</td></tr>
              </tbody>
            </table>`
      }
      <p class="receipt-note">OT rule: hours beyond 40/week are automatic overtime, calculated on the week's total (not day-by-day). WOM-allocated hours are charged to OT before E&amp;F hours. Time off is paid straight time and isn't counted toward the 40-hour threshold. When OT spans more than one WOM, it's split proportionally across them.</p>
    `;
    return wrap;
  }

  async function saveDraft() {
    try {
      await api.put(`/api/technicians/${techId}/weeks/${state.weekMonday}/allocations`, { allocations });
      saveMessage = "Draft saved.";
    } catch (err) {
      saveMessage = err.message;
    }
    draw();
  }

  // Only ever sends Sat/Sun rows -- the already-submitted/approved Mon-Fri
  // rows are never part of this request, matching the endpoint's own
  // restriction to weekend days only.
  async function saveWeekendHours() {
    const weekendAllocations = allocations.filter((a) => a.day === "Sat" || a.day === "Sun");
    try {
      const result = await api.put(`/api/technicians/${techId}/weeks/${state.weekMonday}/weekend-allocations`, {
        allocations: weekendAllocations,
      });
      week.weekendAddendumAt = result.weekendAddendumAt;
      saveMessage = "Weekend hours saved -- your admin will review and adjust as needed.";
    } catch (err) {
      saveMessage = err.message;
    }
    draw();
  }

  // Renders "Flag a punch issue" (with an optional note) directly into a day
  // card, instead of a technician's only option being a phone call or text
  // to admin. Works on any day, locked or not, since the punch problem is
  // about UKG's own record, independent of whether this app's allocation
  // for that day is still editable.
  function wireReportPunchHost(host, day) {
    let expanded = false;

    function drawHost() {
      if (!expanded) {
        host.innerHTML = `<button class="btn btn-link report-punch-btn" type="button">⚠ Flag a punch issue</button>`;
        host.querySelector(".report-punch-btn").addEventListener("click", () => {
          expanded = true;
          drawHost();
        });
        return;
      }
      host.innerHTML = `
        <div class="report-punch-form">
          <input type="text" class="report-punch-note" placeholder="What happened? (optional)" maxlength="500" />
          <button class="btn btn-secondary report-punch-submit" type="button">Submit</button>
          <button class="btn btn-link report-punch-cancel" type="button">Cancel</button>
          <span class="save-message report-punch-message"></span>
        </div>
      `;
      host.querySelector(".report-punch-cancel").addEventListener("click", () => {
        expanded = false;
        drawHost();
      });
      host.querySelector(".report-punch-submit").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const note = host.querySelector(".report-punch-note").value;
        btn.disabled = true;
        try {
          const result = await api.post(`/api/technicians/${techId}/weeks/${state.weekMonday}/report-punch-issue`, {
            day,
            note,
          });
          week.pendingPunchByDay = result.pendingPunchByDay;
          week.pendingPunchDetailByDay = result.pendingPunchDetailByDay;
          draw();
        } catch (err) {
          btn.disabled = false;
          host.querySelector(".report-punch-message").textContent = err.message;
        }
      });
    }

    drawHost();
  }

  async function submit() {
    try {
      await api.put(`/api/technicians/${techId}/weeks/${state.weekMonday}/allocations`, { allocations });
      await api.post(`/api/technicians/${techId}/weeks/${state.weekMonday}/submit`);

      const codesToComplete = [...new Set(allocations.filter((a) => a.type === "wom" && a._markComplete).map((a) => a.womCode))];
      for (const code of codesToComplete) {
        try {
          await api.post(`/api/woms/${encodeURIComponent(code)}/complete`);
        } catch (err) {
          window.alert(`Week was submitted, but could not mark ${code} complete: ${err.message}`);
        }
      }

      await renderTechWeek(container, techIdOverride);
    } catch (err) {
      saveMessage = err.message;
      draw();
    }
  }
}

// A two-stage nudge: ask the question, and if they confirm it's accurate,
// swap to a short note that this will show up flagged for RFM (which, per
// the server's own flagging in Overview, it already will be -- this is just
// making the technician aware, not creating a separate flag on top of it).
// "I'll update my allocation" skips straight past the note, on the
// assumption they're about to go fix the actual cause.
function renderHoursCheckPrompt(stage, questionText, onAccurate, onWillFix) {
  const wrap = document.createElement("div");
  wrap.className = "hours-check-prompt";

  if (stage === "acknowledged") {
    wrap.innerHTML = `
      <p class="hours-check-note">Noted — this will show up flagged for your RFM to review.</p>
      <button type="button" class="btn btn-link hours-check-gotit">Got it</button>
    `;
    wrap.querySelector(".hours-check-gotit").addEventListener("click", onWillFix);
    return wrap;
  }

  wrap.innerHTML = `
    <p class="hours-check-question">${escapeHtml(questionText)}</p>
    <div class="hours-check-actions">
      <button type="button" class="btn btn-link hours-check-fix">I'll update my allocation</button>
      <button type="button" class="btn btn-link hours-check-accurate">This is accurate</button>
    </div>
  `;
  wrap.querySelector(".hours-check-fix").addEventListener("click", onWillFix);
  wrap.querySelector(".hours-check-accurate").addEventListener("click", onAccurate);
  return wrap;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Lenient parse for an hours text field: blank counts as 0, a bad or
// negative value keeps whatever was there before (rather than blowing up
// the day's total to NaN) -- lets mid-typing states like "5." or "" pass
// through harmlessly until a full number lands. No rounding to any fixed
// step (e.g. quarter-hour) -- a real punch can be an odd number of minutes
// (5h4m of OT charged to a WOM, say), and this shouldn't get in the way of
// entering that exactly.
function parseHoursInput(raw, fallback) {
  if (raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

const WEEKLY_OT_THRESHOLD = 40;

// Groups a week's allocation rows into pay buckets (one per WOM, one per
// E&F location, one per time-off type) and splits each bucket's hours into
// regular/OT. Hours beyond 40/week are OT; WOM hours are charged to OT
// before E&F hours; time off is always straight time and excluded from the
// 40-hour threshold entirely. When OT spans multiple WOM (or multiple E&F)
// buckets, it's split proportionally across them — there's no specified
// priority order between individual WOMs.
function computeReceipt(allocations) {
  const buckets = new Map();
  for (const a of allocations) {
    const hours = Number(a.hours || 0);
    if (hours <= 0) continue;
    let key, kind, code;
    if (a.type === "wom") {
      kind = "wom";
      code = a.womCode;
    } else if (a.type === "ef") {
      kind = "ef";
      code = a.locationCode;
    } else {
      kind = "timeoff";
      code = a.timeOffType;
    }
    key = `${kind}:${code}`;
    if (!buckets.has(key)) buckets.set(key, { kind, code, hours: 0 });
    const b = buckets.get(key);
    b.hours = round2(b.hours + hours);
  }

  const bucketList = [...buckets.values()];
  const womBuckets = bucketList.filter((b) => b.kind === "wom");
  const efBuckets = bucketList.filter((b) => b.kind === "ef");
  const timeoffBuckets = bucketList.filter((b) => b.kind === "timeoff");

  const sumWom = round2(womBuckets.reduce((s, b) => s + b.hours, 0));
  const sumEf = round2(efBuckets.reduce((s, b) => s + b.hours, 0));
  const totalWorked = round2(sumWom + sumEf);
  const totalTimeOff = round2(timeoffBuckets.reduce((s, b) => s + b.hours, 0));

  const otTotal = round2(Math.max(0, totalWorked - WEEKLY_OT_THRESHOLD));
  const otFromWom = round2(Math.min(otTotal, sumWom));
  const otFromEf = round2(otTotal - otFromWom);

  function distribute(list, otPool, sumPool) {
    let remaining = otPool;
    list.forEach((b, i) => {
      let ot;
      if (sumPool <= 0) ot = 0;
      else if (i === list.length - 1) ot = remaining; // last bucket absorbs rounding drift
      else ot = round2((otPool * b.hours) / sumPool);
      remaining = round2(remaining - ot);
      b.ot = ot;
      b.reg = round2(b.hours - ot);
    });
  }
  distribute(womBuckets, otFromWom, sumWom);
  distribute(efBuckets, otFromEf, sumEf);
  timeoffBuckets.forEach((b) => {
    b.ot = 0;
    b.reg = b.hours;
  });

  const regularTotal = round2(bucketList.reduce((s, b) => s + b.reg, 0));

  return {
    totalWorked,
    totalTimeOff,
    otTotal,
    otFromWom,
    otFromEf,
    regularTotal,
    buckets: [...womBuckets, ...efBuckets, ...timeoffBuckets],
  };
}
