/* SoloSend dialog — collects a job from the open compose window, then sends or schedules it. */

const $ = (id) => document.getElementById(id);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const composeTabId = Number(new URLSearchParams(location.search).get("composeTab"));

// Parsed CSV lives here once a file is chosen: { headers: string[], rows: string[][] }.
let csv = null;

const els = {
  setupView: $("setupView"),
  progressView: $("progressView"),
  templateSummary: $("templateSummary"),
  toCount: $("toCount"),
  csvPanel: $("csvPanel"),
  csvFile: $("csvFile"),
  csvHeader: $("csvHeader"),
  csvEmailCol: $("csvEmailCol"),
  csvNameCol: $("csvNameCol"),
  txtPanel: $("txtPanel"),
  txtFile: $("txtFile"),
  recipientPreview: $("recipientPreview"),
  delay: $("delay"),
  closeDraft: $("closeDraft"),
  schedulePanel: $("schedulePanel"),
  scheduleAt: $("scheduleAt"),
  setupError: $("setupError"),
  sendBtn: $("sendBtn"),
  scheduleBtn: $("scheduleBtn"),
  confirmScheduleBtn: $("confirmScheduleBtn"),
  cancelScheduleBtn: $("cancelScheduleBtn"),
  scheduledWrap: $("scheduledWrap"),
  scheduledList: $("scheduledList"),
  // progress
  progressPhase: $("progressPhase"),
  progressCount: $("progressCount"),
  barFill: $("barFill"),
  progressCurrent: $("progressCurrent"),
  countdown: $("countdown"),
  statSent: $("statSent"),
  statFailed: $("statFailed"),
  logBox: $("logBox"),
  stopBtn: $("stopBtn"),
  newBtn: $("newBtn"),
  closeBtn: $("closeBtn"),
};

/* ----------------------------------------------------------- parsing utils */

// "Name <email>", "email, Name", or "email".
function parseRecipientLine(line) {
  line = line.trim();
  if (!line) return null;

  const angle = line.match(/^(.*?)<([^>]+)>\s*$/);
  if (angle) {
    const email = angle[2].trim();
    return EMAIL_RE.test(email) ? { email, name: angle[1].trim() } : null;
  }
  const comma = line.indexOf(",");
  const email = (comma === -1 ? line : line.slice(0, comma)).trim();
  const name = comma === -1 ? "" : line.slice(comma + 1).trim();
  return EMAIL_RE.test(email) ? { email, name } : null;
}

function normalizeComposeRecipient(r) {
  if (typeof r === "string") return parseRecipientLine(r);
  if (r && r.address) {
    return EMAIL_RE.test(r.address) ? { email: r.address, name: r.name || "" } : null;
  }
  return null;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\r") {
      /* skip */
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------- compose template */

let composeDetails = null; // cached at init for the summary/To count

async function loadComposeDetails() {
  composeDetails = await browser.compose.getComposeDetails(composeTabId);
  const subject = composeDetails.subject || "(no subject)";
  const toList = (composeDetails.to || []).map(normalizeComposeRecipient).filter(Boolean);
  let attachNote = "";
  try {
    const atts = await browser.compose.listAttachments(composeTabId);
    if (atts.length) attachNote = ` · ${atts.length} attachment(s)`;
  } catch (e) { /* ignore */ }

  // Built as nodes rather than innerHTML: the subject is user data, and the
  // reviewer guide only allows innerHTML for static one-time markup.
  const label = document.createElement("b");
  label.textContent = "Subject:";
  const note = document.createElement("span");
  note.className = "muted";
  note.textContent = "Body and attachments of this email are used as the template.";
  els.templateSummary.replaceChildren(
    label,
    document.createTextNode(` ${subject}${attachNote}`),
    document.createElement("br"),
    note
  );
  els.toCount.textContent = toList.length ? `(${toList.length})` : "(empty)";
}

/* -------------------------------------------------------- recipient source */

function selectedSource() {
  const el = document.querySelector('input[name="source"]:checked');
  return el ? el.value : "to";
}

function onSourceChange() {
  const src = selectedSource();
  els.csvPanel.hidden = src !== "csv";
  els.txtPanel.hidden = src !== "txt";
  updatePreview();
}

async function onCsvChosen() {
  const file = els.csvFile.files[0];
  csv = null;
  if (!file) return updatePreview();
  try {
    const rows = parseCSV(await readFileText(file));
    if (!rows.length) throw new Error("empty file");
    csv = { rows };
    populateCsvColumns();
  } catch (e) {
    setPreview(`Could not read CSV: ${e.message}`, true);
  }
}

function populateCsvColumns() {
  const hasHeader = els.csvHeader.checked;
  // reduce, not Math.max(...spread) — that overflows the stack on a large CSV.
  const width = csv.rows.reduce((max, r) => Math.max(max, r.length), 0);
  const headers = [];
  for (let i = 0; i < width; i++) {
    headers.push(hasHeader ? (csv.rows[0][i] || `Column ${i + 1}`).trim() : `Column ${i + 1}`);
  }
  csv.headers = headers;
  csv.hasHeader = hasHeader;

  const fill = (select, includeNone) => {
    select.replaceChildren();
    if (includeNone) {
      const o = document.createElement("option");
      o.value = "-1"; o.textContent = "— none —";
      select.appendChild(o);
    }
    headers.forEach((h, i) => {
      const o = document.createElement("option");
      o.value = String(i); o.textContent = h;
      select.appendChild(o);
    });
  };
  fill(els.csvEmailCol, false);
  fill(els.csvNameCol, true);

  // Best-effort auto-pick of email / name columns.
  const emailIdx = headers.findIndex((h) => /e-?mail/i.test(h));
  if (emailIdx >= 0) els.csvEmailCol.value = String(emailIdx);
  const nameIdx = headers.findIndex((h) => /name/i.test(h));
  els.csvNameCol.value = nameIdx >= 0 ? String(nameIdx) : "-1";

  updatePreview();
}

// Build the recipient list for the currently selected source.
function buildRecipients() {
  const src = selectedSource();

  if (src === "to") {
    if (!composeDetails) return [];
    return (composeDetails.to || [])
      .map(normalizeComposeRecipient)
      .filter(Boolean)
      .map((r) => ({ email: r.email, name: r.name, fields: { email: r.email, name: r.name } }));
  }

  if (src === "txt") {
    return null; // handled async in gatherJob (needs file read)
  }

  if (src === "csv") {
    if (!csv || !csv.headers) return [];
    const emailIdx = Number(els.csvEmailCol.value);
    const nameIdx = Number(els.csvNameCol.value);
    const dataRows = csv.hasHeader ? csv.rows.slice(1) : csv.rows;
    const out = [];
    for (const row of dataRows) {
      const email = (row[emailIdx] || "").trim();
      if (!EMAIL_RE.test(email)) continue;
      const fields = {};
      csv.headers.forEach((h, i) => { fields[h] = (row[i] || "").trim(); });
      const name = nameIdx >= 0 ? (row[nameIdx] || "").trim() : "";
      fields.email = email;
      fields.name = name;
      out.push({ email, name, fields });
    }
    return out;
  }
  return [];
}

async function buildTxtRecipients() {
  const file = els.txtFile.files[0];
  if (!file) return [];
  const lines = (await readFileText(file)).split(/\r?\n/);
  return lines
    .map(parseRecipientLine)
    .filter(Boolean)
    .map((r) => ({ email: r.email, name: r.name, fields: { email: r.email, name: r.name } }));
}

function setPreview(text, bad) {
  els.recipientPreview.textContent = text;
  els.recipientPreview.classList.toggle("bad", !!bad);
}

async function updatePreview() {
  const src = selectedSource();
  if (src === "txt") {
    if (!els.txtFile.files[0]) return setPreview("Choose a text file.");
    const list = await buildTxtRecipients();
    return setPreview(`${list.length} valid recipient(s) found.`, list.length === 0);
  }
  const list = buildRecipients();
  if (src === "csv" && (!csv || !csv.headers)) return setPreview("Choose a CSV file.");
  setPreview(`${list.length} valid recipient(s) found.`, list.length === 0);
}

/* -------------------------------------------------------------- job build */

async function snapshotAttachments() {
  let atts;
  try {
    atts = await browser.compose.listAttachments(composeTabId);
  } catch (e) {
    return []; // no attachments / tab gone
  }
  const out = [];
  for (const a of atts) {
    const file = await a.getFile();
    out.push({ name: a.name || file.name, type: file.type, dataUrl: await readFileDataUrl(file) });
  }
  return out;
}

// Returns { job, error }.
async function gatherJob() {
  // Re-read the compose window so the latest edits are captured.
  let details;
  try {
    details = await browser.compose.getComposeDetails(composeTabId);
  } catch (e) {
    return { error: "The compose window was closed. Reopen it and click SoloSend again." };
  }

  const src = selectedSource();
  const recipients = src === "txt" ? await buildTxtRecipients() : buildRecipients();
  if (!recipients || recipients.length === 0) {
    return { error: "No valid recipients for the selected source." };
  }

  const attachments = await snapshotAttachments();
  const delaySeconds = Math.max(0, Math.floor(Number(els.delay.value) || 0));

  const job = {
    template: {
      subject: details.subject || "",
      body: details.body || "",
      plainTextBody: details.plainTextBody || "",
      isPlainText: !!details.isPlainText,
      identityId: details.identityId || null,
    },
    attachments,
    recipients,
    delaySeconds,
    sourceLabel: src,
    composeTabId,
    closeComposeTab: els.closeDraft.checked,
  };
  return { job };
}

/* --------------------------------------------------------------- actions */

function showError(msg) {
  els.setupError.textContent = msg;
  els.setupError.hidden = false;
}
function clearError() { els.setupError.hidden = true; }

function busy(btn, label) {
  btn.disabled = true;
  btn.dataset.label = btn.textContent;
  btn.textContent = label;
}
function unbusy(btn) {
  btn.disabled = false;
  if (btn.dataset.label) btn.textContent = btn.dataset.label;
}

async function onSendNow() {
  clearError();
  busy(els.sendBtn, "Preparing…");
  const { job, error } = await gatherJob();
  if (error) { unbusy(els.sendBtn); return showError(error); }

  const res = await browser.runtime.sendMessage({ type: "startJob", job });
  unbusy(els.sendBtn);
  if (!res || !res.ok) return showError(res && res.error ? res.error : "Could not start.");
  render(res.status);
}

function onScheduleToggle() {
  els.schedulePanel.hidden = false;
  els.scheduleBtn.hidden = true;
  els.sendBtn.hidden = true;
  els.confirmScheduleBtn.hidden = false;
  els.cancelScheduleBtn.hidden = false;
  if (!els.scheduleAt.value) {
    const d = new Date(Date.now() + 5 * 60000);
    els.scheduleAt.value = toLocalInputValue(d);
  }
  els.scheduleAt.min = toLocalInputValue(new Date());
}

function onScheduleCancel() {
  els.schedulePanel.hidden = true;
  els.scheduleBtn.hidden = false;
  els.sendBtn.hidden = false;
  els.confirmScheduleBtn.hidden = true;
  els.cancelScheduleBtn.hidden = true;
  clearError();
}

async function onConfirmSchedule() {
  clearError();
  const runAt = new Date(els.scheduleAt.value).getTime();
  if (!runAt || Number.isNaN(runAt)) return showError("Pick a valid date and time.");
  if (runAt <= Date.now()) return showError("Pick a time in the future.");

  busy(els.confirmScheduleBtn, "Scheduling…");
  const { job, error } = await gatherJob();
  if (error) { unbusy(els.confirmScheduleBtn); return showError(error); }

  // The draft won't exist at run time, so close it now (if asked) rather than later.
  const closeNow = job.closeComposeTab;
  job.closeComposeTab = false;

  const res = await browser.runtime.sendMessage({ type: "scheduleJob", job, runAt });
  unbusy(els.confirmScheduleBtn);
  if (!res || !res.ok) return showError(res && res.error ? res.error : "Could not schedule.");

  if (closeNow) { try { await browser.tabs.remove(composeTabId); } catch (e) { /* already closed */ } }

  onScheduleCancel();
  await refreshScheduled();
  setPreview(`Scheduled ${job.recipients.length} email(s) for ${new Date(runAt).toLocaleString()}.`);
}

function toLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function refreshScheduled() {
  const list = await browser.runtime.sendMessage({ type: "listScheduled" });
  els.scheduledList.replaceChildren();
  if (!list || list.length === 0) { els.scheduledWrap.hidden = true; return; }
  els.scheduledWrap.hidden = false;
  for (const item of list) {
    const li = document.createElement("li");
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = new Date(item.runAt).toLocaleString();
    const info = document.createElement("span");
    info.className = "grow muted";
    info.textContent = ` — ${item.count} to · ${item.subject}`;
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.textContent = "Cancel";
    btn.addEventListener("click", async () => {
      await browser.runtime.sendMessage({ type: "cancelScheduled", id: item.id });
      refreshScheduled();
    });
    li.append(when, info, btn);
    els.scheduledList.appendChild(li);
  }
}

/* --------------------------------------------------------------- progress */

const PHASE_LABEL = { sending: "Sending…", waiting: "Waiting…", done: "Finished", idle: "Idle" };

function render(status) {
  if (!status) return;
  if (!status.running && status.phase !== "done") {
    els.setupView.hidden = false;
    els.progressView.hidden = true;
    return;
  }
  els.setupView.hidden = true;
  els.progressView.hidden = false;

  const processed = status.sent + status.failed;
  els.progressCount.textContent = `${processed} / ${status.total}`;
  els.barFill.style.width = status.total ? `${(processed / status.total) * 100}%` : "0";
  els.statSent.textContent = status.sent;
  els.statFailed.textContent = status.failed;

  if (status.phase === "waiting" && status.countdown > 0) {
    els.countdown.hidden = false;
    els.countdown.textContent = `Next send in ${status.countdown}s…`;
    els.progressCurrent.textContent = "";
  } else {
    els.countdown.hidden = true;
    els.progressCurrent.textContent = status.current ? `→ ${status.current}` : "";
  }

  els.logBox.replaceChildren();
  for (const entry of status.log) {
    const div = document.createElement("div");
    div.className = "log-line" + (entry.ok ? "" : " bad");
    const t = document.createElement("span");
    t.className = "log-time";
    t.textContent = `[${entry.time}] `;
    div.appendChild(t);
    div.appendChild(document.createTextNode(entry.message));
    els.logBox.appendChild(div);
  }
  els.logBox.scrollTop = els.logBox.scrollHeight;

  const finished = status.phase === "done";
  els.progressPhase.textContent = finished ? (status.canceled ? "Canceled" : "Finished") : PHASE_LABEL[status.phase];
  els.stopBtn.hidden = finished;
  els.newBtn.hidden = !finished;
  els.closeBtn.hidden = !finished;
}

/* ----------------------------------------------------------------- wiring */

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "progress") render(msg.status);
});

document.querySelectorAll('input[name="source"]').forEach((el) => el.addEventListener("change", onSourceChange));
els.csvFile.addEventListener("change", onCsvChosen);
els.csvHeader.addEventListener("change", () => { if (csv) populateCsvColumns(); });
els.csvEmailCol.addEventListener("change", updatePreview);
els.csvNameCol.addEventListener("change", updatePreview);
els.txtFile.addEventListener("change", updatePreview);
els.sendBtn.addEventListener("click", onSendNow);
els.scheduleBtn.addEventListener("click", onScheduleToggle);
els.cancelScheduleBtn.addEventListener("click", onScheduleCancel);
els.confirmScheduleBtn.addEventListener("click", onConfirmSchedule);
els.stopBtn.addEventListener("click", () => browser.runtime.sendMessage({ type: "cancelJob" }));
els.newBtn.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "resetJob" });
  els.progressView.hidden = true;
  els.setupView.hidden = false;
  await refreshScheduled();
});
els.closeBtn.addEventListener("click", () => window.close());

(async function init() {
  try {
    await loadComposeDetails();
  } catch (e) {
    els.templateSummary.textContent = "Could not read the compose window. Open this from a compose window.";
  }
  await refreshScheduled();
  onSourceChange();
  const status = await browser.runtime.sendMessage({ type: "getStatus" });
  render(status);
})();
