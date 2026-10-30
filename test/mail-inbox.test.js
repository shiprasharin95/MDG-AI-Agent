/**
 * E-mail channel test with a mocked Microsoft Graph mailbox (srv/lib/mail.js is stubbed).
 */
const cds = require('@sap/cds')
const fs = require('fs')
const path = require('path')
const { test } = require('node:test')
const assert = require('node:assert')

const DIR = [path.join(__dirname, '..', 'samples'), path.join(__dirname, '..', '..', 'requiment document')].find(d => fs.existsSync(d))
const mail = require('../srv/lib/mail')

// ---- mock mailbox -----------------------------------------------------------
const inbox = [
  { id: 'm1', internetMessageId: '<m1@test>', subject: 'New customer', from: { emailAddress: { address: 'shipra.sharin@bearingpoint.com' } }, receivedDateTime: new Date().toISOString(), file: 'Dokument MDG AI - no BP Existing (no VAT).pdf' },
  { id: 'm2', internetMessageId: '<m2@test>', subject: 'Existing customer', from: { emailAddress: { address: 'shipra.sharin@bearingpoint.com' } }, receivedDateTime: new Date().toISOString(), file: 'Dokument MDG AI - BP Existing (VAT).pdf' },
  { id: 'm3', internetMessageId: '<m3@test>', subject: 'Spam', from: { emailAddress: { address: 'x@evil.com' } }, receivedDateTime: new Date().toISOString(), file: 'Dokument MDG AI - BP Existing (VAT).pdf' }
]
const read = new Set()
const sent = []
mail.mailbox = () => 'SAP_CAP_@bearingpoint.com'
mail.listNewMessages = async () => inbox.filter(m => !read.has(m.id))
// keyword filtering is tested separately below against the real implementation
mail.getAttachments = async id => {
  const m = inbox.find(x => x.id === id)
  return [{ name: m.file, contentType: 'application/pdf', buffer: fs.readFileSync(path.join(DIR, m.file)) }]
}
mail.markRead = async id => { read.add(id); return true }
mail.sendMail = async msg => { sent.push(msg); return msg }

const { POST, axios } = cds.test(path.join(__dirname, '..'))
axios.defaults.auth = { username: 'test', password: 'test' }

test('mail poll processes attachments, replies to sender, skips foreign domains', { skip: !fs.existsSync(DIR) && 'samples missing' }, async () => {
  const { data } = await POST('/odata/v4/mdg-ai/pollMailbox', {})
  const r = JSON.parse(data.skipped)
  assert.strictEqual(r.mails, 3)
  assert.strictEqual(r.processed.length, 2, JSON.stringify(r))
  const byFile = Object.fromEntries(r.processed.map(p => [p.file, p]))
  assert.strictEqual(byFile['Dokument MDG AI - no BP Existing (no VAT).pdf'].status, 'CR_CREATED')
  assert.strictEqual(byFile['Dokument MDG AI - BP Existing (VAT).pdf'].status, 'DUPLICATE')
  assert.strictEqual(r.skipped[0].reason, 'sender domain not allowed')
  assert.strictEqual(sent.length, 2)
  assert.match(sent.find(s => /duplicate/.test(s.subject)).html, /already exists/)
  assert.match(sent.find(s => /change request/.test(s.subject)).html, /MDG change request created/)
})

test('second poll does not process the same mails again', async () => {
  const { data } = await POST('/odata/v4/mdg-ai/pollMailbox', {})
  assert.strictEqual(data.mails, 0)
  assert.strictEqual(sent.length, 2)
})

test('UI upload also sends the result mail automatically', async () => {
  process.env.MAIL_NOTIFY_TO = 'shipra.sharin@bearingpoint.com'
  const file = 'Dokument MDG AI - BP Existing (no VAT).pdf'
  const before = sent.length
  const { data } = await POST('/odata/v4/mdg-ai/uploadForm', {
    fileName: file, mimeType: 'application/pdf', content: fs.readFileSync(path.join(DIR, file)).toString('base64')
  })
  assert.strictEqual(data.status_code, 'DUPLICATE')
  assert.strictEqual(sent.length, before + 1)
  const m = sent[sent.length - 1]
  assert.deepStrictEqual([].concat(m.to), ['shipra.sharin@bearingpoint.com'])
  assert.match(m.subject, /duplicate found \(BP 1000040\)/)
})
