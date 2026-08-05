/*
 * SoloSend — background: opens the dialog, runs the send loop, handles schedules.
 *
 * The dialog only collects a "job" (a template + recipients + delay) and hands
 * it here. All sending happens in this persistent background script so that
 * closing the dialog window never interrupts an in-progress run, and the delay
 * between sends is never cut short.
 *
 * A job looks like:
 *   {
 *     template:    { subject, body, plainTextBody, isPlainText, identityId },
 *     attachments: [ { name, type, dataUrl } ],
 *     recipients:  [ { email, name, fields } ],   // fields = per-recipient merge values
 *     delaySeconds: number
 *   }
 */

const SCHED_KEY = "solosend.scheduled";
const MAX_ATTACH_BYTES = 25 * 1024 * 1024; // guard against oversized scheduled jobs

/* ------------------------------------------------------------------ state */

const state = {
  running: false,
  canceled: false,
  phase: "idle", // "idle" | "sending" | "waiting" | "done"
  source: "",
  total: 0,
  sent: 0,
  failed: 0,
  index: 0,
  current: null,
  countdown: 0,
  delaySeconds: 0,
  log: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function addLog(ok, message) {
  state.log.push({ time: new Date().toLocaleTimeString(), ok, message });
  if (state.log.length > 500) state.log.shift();
}

function publicState() {
  return {
    running: state.running,
    canceled: state.canceled,
    phase: state.phase,
    source: state.source,
    total: state.total,
    sent: state.sent,
    failed: state.failed,
    index: state.index,
    current: state.current,
    countdown: state.countdown,
    delaySeconds: state.delaySeconds,
    log: state.log,
  };
}

function broadcast() {
  browser.runtime.sendMessage({ type: "progress", status: publicState() }).catch(() => {});
}

/* -------------------------------------------------------------- send loop */

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// `escape` is set for HTML bodies so a merge value like "Smith & Sons <Ltd>"
// becomes text instead of broken markup. Subjects are plain text, so not there.
function personalize(template, recipient, escape) {
  let out = String(template == null ? "" : template);
  const fields = recipient.fields || {};
  // Canonical name/email win over same-named columns, and an empty name column
  // falls back to the address's local part.
  const merged = {
    ...fields,
    email: recipient.email,
    name: recipient.name || fields.name || recipient.email.split("@")[0],
  };
  for (const [key, value] of Object.entries(merged)) {
    const replacement = value == null ? "" : String(value);
    out = out.split(`{{${key}}}`).join(escape ? escapeHtml(replacement) : replacement);
  }
  return out;
}

// A display name is always quoted: "Doe, Jane <jane@x.com>" unquoted parses as
// two separate recipients, which silently sends to the wrong addresses.
function formatAddress(recipient) {
  const name = (recipient.name || "").trim();
  if (!name) return recipient.email;
  return `"${name.replace(/([\\"])/g, "\\$1")}" <${recipient.email}>`;
}

// Rebuild File objects from the data URLs captured in the dialog.
async function buildFiles(attachments) {
  const files = [];
  for (const a of attachments || []) {
    try {
      const blob = await (await fetch(a.dataUrl)).blob();
      files.push({ file: new File([blob], a.name, { type: a.type || blob.type }), name: a.name });
    } catch (e) {
      addLog(false, `Could not attach "${a.name}" — ${e && e.message ? e.message : e}`);
    }
  }
  return files;
}

async function sendOne(recipient, files, template) {
  const details = { to: [formatAddress(recipient)], subject: personalize(template.subject, recipient) };
  if (template.identityId) details.identityId = template.identityId;

  if (template.isPlainText) {
    details.isPlainText = true;
    details.plainTextBody = personalize(template.plainTextBody, recipient);
  } else {
    details.isPlainText = false;
    details.body = personalize(template.body, recipient, true);
  }

  const tab = await browser.compose.beginNew(details);
  try {
    for (const f of files) {
      try {
        await browser.compose.addAttachment(tab.id, f);
      } catch (e) {
        addLog(false, `Attachment "${f.name}" failed for ${recipient.email}`);
      }
    }
    // A successful send closes this tab itself.
    await browser.compose.sendMessage(tab.id, { mode: "sendNow" });
  } catch (e) {
    // Otherwise it would be left open — one stranded compose window per failure.
    try {
      await browser.tabs.remove(tab.id);
    } catch (_) {
      /* already gone */
    }
    throw e;
  }
}

async function delayWithCountdown(seconds) {
  state.phase = "waiting";
  for (let s = seconds; s > 0; s--) {
    if (state.canceled) return;
    state.countdown = s;
    broadcast();
    await sleep(1000);
  }
  state.countdown = 0;
}

async function runJob(job, sourceLabel) {
  state.running = true;
  state.canceled = false;
  state.phase = "sending";
  state.source = sourceLabel || "";
  state.total = job.recipients.length;
  state.sent = 0;
  state.failed = 0;
  state.index = 0;
  state.current = null;
  state.countdown = 0;
  state.delaySeconds = job.delaySeconds;
  state.log = [];
  addLog(true, `Starting: ${state.total} email(s), ${job.delaySeconds}s between each.`);
  broadcast();

  const files = await buildFiles(job.attachments);
  if (files.length) addLog(true, `${files.length} attachment(s) will be included.`);

  for (let i = 0; i < job.recipients.length; i++) {
    if (state.canceled) {
      addLog(false, "Run canceled.");
      break;
    }
    const recipient = job.recipients[i];
    state.index = i;
    state.current = recipient.email;
    state.phase = "sending";
    broadcast();

    try {
      await sendOne(recipient, files, job.template);
      state.sent++;
      addLog(true, `Sent to ${recipient.email}`);
    } catch (err) {
      state.failed++;
      addLog(false, `Failed: ${recipient.email} — ${err && err.message ? err.message : err}`);
    }
    broadcast();

    const isLast = i === job.recipients.length - 1;
    if (!isLast && !state.canceled && job.delaySeconds > 0) {
      await delayWithCountdown(job.delaySeconds);
    }
  }

  state.running = false;
  state.phase = "done";
  state.current = null;
  state.countdown = 0;

  // Optionally close the original draft — but only on a fully clean run, so a
  // failed or canceled send leaves the template intact for a retry.
  if (job.closeComposeTab && typeof job.composeTabId === "number" && state.failed === 0 && !state.canceled) {
    try {
      await browser.tabs.remove(job.composeTabId);
      addLog(true, "Closed the original draft.");
    } catch (e) {
      /* draft already closed */
    }
  }

  const summary = `Done. Sent ${state.sent}, failed ${state.failed}${state.canceled ? " (canceled)" : ""}.`;
  addLog(true, summary);
  broadcast();
  notify(summary);
}

function notify(message) {
  try {
    browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon.svg"),
      title: "SoloSend",
      message,
    }).catch(() => {});
  } catch (e) {
    /* best effort */
  }
}

/* ----------------------------------------------------------- scheduling */

async function getScheduled() {
  const stored = await browser.storage.local.get(SCHED_KEY);
  return stored[SCHED_KEY] || [];
}
async function setScheduled(list) {
  await browser.storage.local.set({ [SCHED_KEY]: list });
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function attachmentBytes(attachments) {
  // data URL length → rough byte count (base64 ≈ 4/3 of bytes).
  return (attachments || []).reduce((sum, a) => sum + Math.floor((a.dataUrl.length * 3) / 4), 0);
}

async function scheduleJob(job, runAt) {
  if (attachmentBytes(job.attachments) > MAX_ATTACH_BYTES) {
    return { ok: false, error: "Attachments are too large to schedule. Try 'Send now', or remove attachments." };
  }
  const id = makeId();
  const entry = {
    id,
    runAt,
    job,
    createdAt: Date.now(),
    count: job.recipients.length,
  };
  const list = await getScheduled();
  list.push(entry);
  await setScheduled(list);
  browser.alarms.create("solosend-" + id, { when: runAt });
  return { ok: true, id };
}

async function cancelScheduled(id) {
  const list = await getScheduled();
  await setScheduled(list.filter((e) => e.id !== id));
  browser.alarms.clear("solosend-" + id);
  return { ok: true };
}

async function listScheduledPublic() {
  const list = await getScheduled();
  return list
    .map((e) => ({ id: e.id, runAt: e.runAt, count: e.count, subject: e.job.template.subject || "(no subject)" }))
    .sort((a, b) => a.runAt - b.runAt);
}

async function runScheduled(id) {
  const list = await getScheduled();
  const idx = list.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const entry = list[idx];

  // If a run is already in progress, defer this one rather than overlap.
  if (state.running) {
    browser.alarms.create("solosend-" + id, { when: Date.now() + 30000 });
    return;
  }

  // Remove before running so a background reload can't double-send it.
  list.splice(idx, 1);
  await setScheduled(list);
  await runJob(entry.job, "Scheduled");
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("solosend-")) {
    runScheduled(alarm.name.slice("solosend-".length));
  }
});

// Re-arm alarms whenever the background loads (startup, or after being idle).
async function recoverSchedules() {
  const list = await getScheduled();
  const now = Date.now();
  for (const entry of list) {
    const when = entry.runAt <= now ? now + 3000 : entry.runAt; // missed jobs fire shortly after launch
    browser.alarms.create("solosend-" + entry.id, { when });
  }
}
recoverSchedules();

/* ---------------------------------------------------- compose-window button */

browser.composeAction.onClicked.addListener(async (tab) => {
  const url = browser.runtime.getURL("dialog/dialog.html") + "?composeTab=" + tab.id;
  await browser.windows.create({
    url,
    type: "popup",
    width: 480,
    height: 720,
    allowScriptsToClose: true,
  });
});

/* -------------------------------------------------------------- messaging */

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "getStatus":
      return Promise.resolve(publicState());

    case "startJob": {
      if (state.running) return Promise.resolve({ ok: false, error: "A send run is already in progress." });
      if (!msg.job || !msg.job.recipients || msg.job.recipients.length === 0) {
        return Promise.resolve({ ok: false, error: "No valid recipients." });
      }
      runJob(msg.job, msg.job.sourceLabel || "");
      return Promise.resolve({ ok: true, status: publicState() });
    }

    case "scheduleJob": {
      if (!msg.job || !msg.job.recipients || msg.job.recipients.length === 0) {
        return Promise.resolve({ ok: false, error: "No valid recipients." });
      }
      if (!msg.runAt || msg.runAt <= Date.now()) {
        return Promise.resolve({ ok: false, error: "Pick a time in the future." });
      }
      return scheduleJob(msg.job, msg.runAt);
    }

    case "listScheduled":
      return listScheduledPublic();

    case "cancelScheduled":
      return cancelScheduled(msg.id);

    case "cancelJob":
      if (state.running) {
        state.canceled = true;
        addLog(false, "Cancel requested — finishing the current step then stopping.");
        broadcast();
      }
      return Promise.resolve({ ok: true });

    case "resetJob":
      if (!state.running) {
        state.phase = "idle";
        state.current = null;
        state.countdown = 0;
        state.log = [];
      }
      return Promise.resolve({ ok: true });

    default:
      return;
  }
});
