# SoloSend

A Thunderbird desktop add-on (MailExtension). Write an email normally in the
compose window, then click **SoloSend** in the compose toolbar to deliver it to
many recipients **one at a time**, with a **delay** between each — or
**schedule** the whole run for later.

Each recipient gets their own individually addressed email (their own "To:"),
so nobody sees the rest of the list, and the staggered delay is gentle on your
mail provider's sending limits.

## How you use it

1. In Thunderbird, click **Write** and compose your email as usual — subject,
   body, formatting, and attachments all become the template.
2. Click **SoloSend** in the compose window's toolbar (next to *Mail Merge*).
   A dialog window opens.
3. Choose where the recipients come from:
   - **This email's To field** — whatever you already typed into *To*.
   - **CSV file** — pick the file, then choose which column holds the email
     address (and optionally a name column).
   - **Text file** — one email address per line.
4. Set the **delay after each email** (default **2 seconds**; `0` = back to back).
5. Click **Send now**, or **Schedule…** to pick a date and time.

Progress (sent / failed counts, current recipient, a live countdown to the next
send, and a log) shows in the dialog. You can close the dialog — sending
continues in the background — and you'll get a notification when it finishes.

## Personalization (mail merge)

Put placeholders in the subject or body and they're filled in per recipient:

- `{{name}}` and `{{email}}` work for every source.
- For a **CSV**, *any* column is available as `{{ColumnName}}` — e.g. a
  `Company` column becomes `{{Company}}`.

```
Subject:  Hi {{name}}, an update for {{Company}}
Body:     Hello {{name}}, we're reaching out to {{email}}…
```

## Recipient formats (To field / text file)

One per line, any of:

```
jane@example.com
bob@example.com, Bob Smith
Carol Lee <carol@example.com>
```

Invalid lines are skipped.

## Scheduling notes

Scheduled runs are saved and fire via Thunderbird's alarms. **Thunderbird must
be running at the scheduled time.** If Thunderbird was closed when the time
passed, SoloSend runs the job shortly after you next open it. Pending schedules
are listed in the dialog and can be canceled there.

## Install for testing (temporary)

1. **Tools ▸ Developer Tools ▸ Debug Add-ons** (or *Add-ons Manager ▸ gear ▸
   Debug Add-ons*).
2. **Load Temporary Add-on…** and select this project's `manifest.json`.
3. Open a compose window — the **SoloSend** button is in its toolbar.

Temporary add-ons are removed when Thunderbird restarts; use **Reload** on the
Debug Add-ons page after editing the code.

## Package for distribution

Only these four paths belong in the package — `manifest.json` must sit at the
archive root, and `test-files/` and the logs must stay out.

```sh
zip -r -FS dist/solosend.xpi manifest.json background.js dialog icons
```

On Windows without `zip`:

```powershell
Compress-Archive -Path manifest.json,background.js,dialog,icons -DestinationPath dist\solosend.zip -Force
Rename-Item dist\solosend.zip solosend.xpi
```

Install via **Add-ons Manager ▸ gear ▸ Install Add-on From File…** Thunderbird
does not require signed add-ons, so this `.xpi` installs as-is; the same file is
what you upload to [addons.thunderbird.net](https://addons.thunderbird.net).

## How it works

The compose-toolbar button (`compose_action`) opens a dialog **window** (not a
panel, so it stays open to show progress). The dialog snapshots the compose
window's subject/body/attachments and the chosen recipients into a job and hands
it to a persistent background script, which drives the run with the Thunderbird
`compose` API (`compose.beginNew` → `addAttachment` → `compose.sendMessage`).
Keeping the loop in the background means closing the dialog never interrupts a
run and the delay is never cut short. Scheduled jobs are persisted to storage
and fired with the `alarms` API.

> A compose window briefly opens and closes for each email as it is sent — this
> is expected; it's how the WebExtension compose API delivers mail. Your
> original draft stays open as the template; close it when you're done.

## Requirements

Thunderbird 115 or newer.
