/**
 * Microsoft Graph mail access - same setup as the Job Failure Monitor
 * (AI_JOB_FAILED_MONITOR/srv/job-failure-agent.js):
 *   BTP destination  AzureMailService  (OAuth2 client credentials -> graph.microsoft.com)
 *   sender mailbox   cap-notifications@bearingpoint.com  (MAIL_FROM / destination property MailSenderUser)
 *
 * Inbound (new): read unread mails with attachments from the inbox mailbox (MAIL_INBOX).
 * Requires Graph APPLICATION permission Mail.Read (and Mail.ReadWrite to mark mails as read)
 * on the app registration behind AzureMailService - the job monitor only needed Mail.Send.
 */
const cds = require('@sap/cds')
const { getDestination } = require('@sap-cloud-sdk/connectivity')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')

const LOG = cds.log('mdgai-mail')
const MAIL_DESTINATIONS = [process.env.MAIL_DESTINATION, 'AzureMailService'].filter(Boolean)

function property (destination, name) {
  if (destination[name]) return destination[name]
  const props = destination.originalProperties || {}
  const key = Object.keys(props).find(k => k.toLowerCase() === name.toLowerCase())
  return key ? props[key] : undefined
}

let cached
async function graph () {
  if (cached) return cached
  for (const name of MAIL_DESTINATIONS) {
    const dest = await getDestination({ destinationName: name })
    if (dest) {
      const basePath = property(dest, 'GraphApiBasePath') || (/\/v1\.0\/?$/i.test(dest.url || '') ? '' : '/v1.0')
      const sender = property(dest, 'MailSenderUser') || process.env.MAIL_FROM || 'cap-notifications@bearingpoint.com'
      cached = { dest, name, basePath, sender }
      return cached
    }
  }
  throw new Error(`No mail destination found (${MAIL_DESTINATIONS.join(', ')})`)
}

async function call (method, path, data) {
  const g = await graph()
  try {
    const res = await executeHttpRequest(g.dest, {
      method, url: `${g.basePath}${path}`,
      headers: { 'content-type': 'application/json' },
      ...(data ? { data } : {})
    }, { fetchCsrfToken: false })
    return res.data
  } catch (e) {
    const r = e.cause?.response || e.response
    const msg = r?.data?.error?.message || r?.data?.message || e.message
    const err = new Error(`Graph ${method.toUpperCase()} ${path.split('?')[0]} -> ${r?.status || '?'}: ${msg}`)
    err.status = r?.status
    throw err
  }
}

const mailbox = () => process.env.MAIL_INBOX

/** Unread mails with attachments in the inbox (oldest first) */
async function listNewMessages (top = 10) {
  // Only mails whose subject CONTAINS the keyword (case-insensitive), default "ai mdg agent".
  // Graph cannot filter "contains, case-insensitive" reliably -> filter here.
  // All other mails in the mailbox stay untouched (not read, not marked).
  const keyword = (process.env.MAIL_SUBJECT_KEYWORD ?? 'ai mdg agent').trim().toLowerCase()
  const q = `$filter=${encodeURIComponent('isRead eq false and hasAttachments eq true')}` +
    `&$select=id,internetMessageId,subject,from,receivedDateTime,hasAttachments&$top=50`
  const data = await call('get', `/users/${encodeURIComponent(mailbox())}/mailFolders/inbox/messages?${q}`)
  const norm = s => String(s || '').toLowerCase().replace(/[\s_-]+/g, ' ')
  return (data?.value || [])
    .filter(m => !keyword || norm(m.subject).includes(norm(keyword)))
    .sort((a, b) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime)))
    .slice(0, top)
}

/** File attachments (base64 content) of one mail */
async function getAttachments (messageId) {
  const data = await call('get', `/users/${encodeURIComponent(mailbox())}/messages/${encodeURIComponent(messageId)}/attachments`)
  return (data?.value || [])
    .filter(a => (a['@odata.type'] || '').includes('fileAttachment') && !a.isInline && a.contentBytes)
    .map(a => ({ name: a.name, contentType: a.contentType, size: a.size, buffer: Buffer.from(a.contentBytes, 'base64') }))
}

/** Mark as read - needs Mail.ReadWrite; failure is tolerated (DB de-duplication still applies) */
async function markRead (messageId) {
  try {
    await call('patch', `/users/${encodeURIComponent(mailbox())}/messages/${encodeURIComponent(messageId)}`, { isRead: true })
    return true
  } catch (e) {
    LOG.warn(`Could not mark mail as read (Mail.ReadWrite missing?): ${e.message}`)
    return false
  }
}

/** Send a mail from cap-notifications@bearingpoint.com */
async function sendMail ({ to, subject, html, replyToMessageId }) {
  const g = await graph()
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: [].concat(to).filter(Boolean).map(address => ({ emailAddress: { address } }))
  }
  await call('post', `/users/${encodeURIComponent(g.sender)}/sendMail`, { message, saveToSentItems: true })
  return { from: g.sender, to, subject, replyToMessageId }
}

module.exports = { graph, listNewMessages, getAttachments, markRead, sendMail, mailbox }
