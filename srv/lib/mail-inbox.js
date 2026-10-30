/**
 * E-mail channel:
 *   1. A user sends a mail with the customer form (PDF / image) to MAIL_INBOX
 *      (e.g. SAP_CAP_@bearingpoint.com).
 *   2. This poller reads unread mails with attachments via Microsoft Graph.
 *   3. Every attachment runs through the same pipeline as the UI upload:
 *      AI extraction -> duplicate check in S23 -> MDG change request.
 *   4. The sender gets a reply from cap-notifications@bearingpoint.com with the result
 *      (duplicate BP number or CR number) - same mail setup as the Job Failure Monitor.
 *
 * Triggers: interval poller (MAIL_POLL_SECONDS, default 120) and POST /mail/poll
 * (for SAP Job Scheduling or manual runs).
 */
const cds = require('@sap/cds')
const mail = require('./mail')

const LOG = cds.log('mdgai-mail')
const SUPPORTED = /^(application\/pdf|image\/(png|jpe?g|gif|bmp|webp|tiff?))$/i
const SUPPORTED_EXT = /\.(pdf|png|jpe?g|gif|bmp|webp|tiff?)$/i

let running = false

function allowedSender (address) {
  const a = String(address || '').toLowerCase()
  const domains = (process.env.MAIL_ALLOWED_SENDER_DOMAINS || 'bearingpoint.com').split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
  return domains.some(d => a.endsWith(`@${d}`))
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * Links into S23 (client 120).
 *  S23_NWBC_URL      : NWBC entry (MDG launchpad)
 *  S23_CR_LINK       : direct link to one CR, placeholder {CR} = CR number (12 digits)
 *                      Default: MDG BP change request UI (Web Dynpro BS_OVP_BP, UI config
 *                      BS_OVP_BP_ALL - same as CR type ZBP1P1) in display mode for that CR.
 */
const S23_BASE = () => (process.env.S23_WEB_URL || 'http://bedusapp23.dev.bearingpoint.com:50000').replace(/\/$/, '')
const S23_CLIENT = () => process.env.S23_WEB_CLIENT || '120'
function nwbcUrl () {
  return process.env.S23_NWBC_URL ||
    `${S23_BASE()}/ui2/nwbc/?sap-nwbc-node=navigate_absolute&sap-nwbc-new_window=X&sap-client=${S23_CLIENT()}`
}
function crUrl (crNumber) {
  if (!/^\d+$/.test(String(crNumber || ''))) return null
  const cr = String(crNumber).padStart(12, '0')
  const tpl = process.env.S23_CR_LINK ||
    `${S23_BASE()}/sap/bc/webdynpro/sap/bs_ovp_bp?sap-client=${S23_CLIENT()}` +
    `&sap-wd-configid=BS_OVP_BP_ALL&CREQUEST={CR}&ACTION=DISPLAY&USMD_OTC=147`
  return tpl.replace(/\{CR\}/g, cr)
}

function resultHtml (u) {
  const appUrl = process.env.APP_URL || 'https://mdg-ai-bp.cfapps.eu20-001.hana.ondemand.com'
  const link = `${appUrl}/bpupload/webapp/index.html#/FormUploads(${u.ID})`
  const crLink = crUrl(u.crNumber)
  const status = {
    DUPLICATE: { color: '#e9730c', title: 'Business partner already exists - no change request created' },
    CR_CREATED: { color: '#107e3e', title: 'MDG change request created' },
    NO_MATCH: { color: '#0a6ed1', title: 'No duplicate found' },
    ERROR: { color: '#bb0000', title: 'Processing error' }
  }[u.status_code] || { color: '#555', title: u.status_code }

  const row = (l, v) => `<tr><td style="padding:3px 14px 3px 0;color:#555">${l}</td><td>${esc(v || '-')}</td></tr>`
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
  <p>Hello,</p>
  <p>your customer form <b>${esc(u.fileName)}</b> was processed by <i>MDG with AI</i>.</p>
  <p style="font-size:16px;color:${status.color}"><b>${esc(status.title)}</b></p>
  <table style="border-collapse:collapse">
    ${row('Name', u.name)}
    ${row('Address', `${u.street || ''} ${u.houseNumber || ''}, ${u.postalCode || ''} ${u.city || ''}, ${u.country || ''}`)}
    ${row('Tax number', u.taxNumber)}
    ${u.matchedPartner ? row('Existing business partner', `${u.matchedPartner} (${u.matchReason || ''})`) : ''}
    ${u.crNumber ? row('MDG change request', `${u.crNumber} (type ${u.crType || ''}, status ${u.crStatus || ''})`) : ''}
  </table>
  <p style="margin-top:12px">${esc(u.message || '')}</p>
  ${crLink ? `<p style="margin:14px 0">
    <a href="${esc(crLink)}" style="background:#0a6ed1;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none">Open change request ${esc(String(u.crNumber).replace(/^0+/, ''))} in S23 MDG</a>
  </p>` : ''}
  <p>
    <a href="${link}">Open in the MDG with AI app</a>
    &nbsp;|&nbsp; <a href="${esc(nwbcUrl())}">Open MDG in S23 (NWBC)</a>
  </p>
  ${crLink ? `<p style="color:#777;font-size:12px">If the change request link does not open directly, open NWBC and search for change request ${esc(String(u.crNumber).replace(/^0+/, ''))} under "My Change Requests".</p>` : ''}
  <hr style="border:0;border-top:1px solid #ddd;margin:18px 0">
  <p style="color:#777;font-size:12px">Automatic message from SAP CAP (MDG with AI). Data was extracted by AI - please verify it in the change request before approval.</p>
</div>`
}

/**
 * Processes all new mails once.
 * @param processUpload  async ({ fileName, mimeType, buffer, mailMeta }) => FormUploads row
 */
async function pollOnce (processUpload) {
  if (!mail.mailbox()) return { skipped: 'MAIL_INBOX not configured' }
  if (running) return { skipped: 'poll already running' }
  running = true
  const result = { mails: 0, attachments: 0, processed: [], skipped: [], errors: [] }
  try {
    const { FormUploads } = cds.entities('mdgai')
    const messages = await mail.listNewMessages(Number(process.env.MAIL_POLL_BATCH || 10))
    for (const m of messages) {
      result.mails++
      const from = m.from?.emailAddress?.address
      const msgKey = m.internetMessageId || m.id
      try {
        // never process our own result mails (inbox = sender mailbox cap-notifications@)
        const own = (process.env.MAIL_FROM || 'cap-notifications@bearingpoint.com').toLowerCase()
        if (String(from || '').toLowerCase() === own) {
          await mail.markRead(m.id)
          continue
        }
        if (!allowedSender(from)) {
          result.skipped.push({ subject: m.subject, from, reason: 'sender domain not allowed' })
          await mail.markRead(m.id)
          continue
        }
        // de-duplication: a mail is processed only once even if it cannot be marked as read
        const seen = await SELECT.one.from(FormUploads).columns('ID').where({ mailMessageId: msgKey })
        if (seen) { await mail.markRead(m.id); continue }

        const files = (await mail.getAttachments(m.id))
          .filter(a => SUPPORTED.test(a.contentType || '') || SUPPORTED_EXT.test(a.name || ''))
        if (!files.length) {
          result.skipped.push({ subject: m.subject, from, reason: 'no PDF/image attachment' })
          await mail.markRead(m.id)
          continue
        }

        for (const f of files) {
          result.attachments++
          const mimeType = SUPPORTED.test(f.contentType || '') ? f.contentType
            : (/\.pdf$/i.test(f.name) ? 'application/pdf' : 'image/jpeg')
          const row = await processUpload({
            fileName: f.name, mimeType, buffer: f.buffer,
            mailMeta: { source: 'EMAIL', mailMessageId: msgKey, mailFrom: from, mailSubject: (m.subject || '').slice(0, 255), mailReceivedAt: m.receivedDateTime }
          })
          // result mail is sent inside processDocument (notifyResult) for every channel
          const done = await SELECT.one.from(FormUploads, row.ID).columns('replyStatus')
          result.processed.push({ file: f.name, from, status: row.status_code, crNumber: row.crNumber, matchedPartner: row.matchedPartner, reply: done?.replyStatus })
        }
        await mail.markRead(m.id)
      } catch (e) {
        LOG.error(`Mail "${m.subject}" from ${from} failed:`, e)
        result.errors.push({ subject: m.subject, from, message: e.message })
      }
    }
  } catch (e) {
    LOG.error('Mail poll failed:', e.message)
    result.errors.push({ message: e.message })
  } finally {
    running = false
  }
  if (result.mails) LOG.info('Mail poll', JSON.stringify(result))
  return result
}

/**
 * Result notification - sent automatically after AI extraction + duplicate check
 * (+ CR creation) for EVERY document, whether uploaded in the UI or received by mail.
 * Recipient: MAIL_REPLY_TO (test) > mail sender (EMAIL) > MAIL_NOTIFY_TO > uploading user.
 */
async function notifyResult (row, { userEmail } = {}) {
  const { FormUploads } = cds.entities('mdgai')
  if (process.env.MAIL_NOTIFY === 'false') return
  const to = process.env.MAIL_REPLY_TO ||
    (row.source === 'EMAIL' ? row.mailFrom : null) ||
    process.env.MAIL_NOTIFY_TO ||
    (/@/.test(userEmail || '') ? userEmail : null)
  if (!to) {
    await UPDATE(FormUploads, row.ID).with({ replyStatus: 'no recipient configured' })
    return
  }
  const what = row.status_code === 'DUPLICATE' ? `duplicate found (BP ${row.matchedPartner})`
    : row.crNumber ? `MDG change request ${row.crNumber} created`
      : row.status_code === 'ERROR' ? 'processing error' : row.status_code
  const subject = `${row.source === 'EMAIL' ? `Re: ${row.mailSubject || row.fileName}` : `MDG with AI: ${row.fileName}`} - ${what}`
  let replyStatus
  try {
    await mail.sendMail({ to, subject, html: resultHtml(row) })
    replyStatus = `sent to ${to}`
  } catch (e) {
    replyStatus = `mail failed: ${e.message}`.slice(0, 255)
    LOG.error(replyStatus)
  }
  await UPDATE(FormUploads, row.ID).with({ replySentAt: new Date().toISOString(), replyStatus })
}

function startPoller (processUpload) {
  const secs = Number(process.env.MAIL_POLL_SECONDS || 120)
  if (!mail.mailbox() || !secs) {
    LOG.info('Mail inbox polling disabled (MAIL_INBOX / MAIL_POLL_SECONDS not set)')
    return
  }
  LOG.info(`Polling ${mail.mailbox()} every ${secs}s`)
  const tick = () => cds.tx(() => pollOnce(processUpload)).catch(e => LOG.error(e.message))
  setTimeout(tick, 15000)
  setInterval(tick, secs * 1000).unref()
}

module.exports = { pollOnce, startPoller, resultHtml, notifyResult, crUrl, nwbcUrl }
