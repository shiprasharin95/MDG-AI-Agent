const cds = require('@sap/cds')
const extractor = require('./lib/extractor')
const matching = require('./lib/matching')
const s23 = require('./lib/s23')

const LOG = cds.log('mdgai')
const CRIT = { UPLOADED: 0, EXTRACTED: 2, DUPLICATE: 2, NO_MATCH: 2, CR_CREATED: 3, ERROR: 1 }

module.exports = class MdgAiService extends cds.ApplicationService {
  init () {
    const { FormUploads } = this.entities
    const db = mdgai()

    /* ----------------------------------------------------------- */
    /* Upload (Step 1) + full processing                           */
    /* ----------------------------------------------------------- */
    this.on('uploadForm', async req => {
      const { fileName, mimeType, content } = req.data
      if (!content) return req.error(400, 'No file content received')
      const buffer = Buffer.from(content.replace(/^data:[^;]+;base64,/, ''), 'base64')
      if (!buffer.length) return req.error(400, 'Uploaded file is empty')
      if (!/^(image\/|application\/pdf)/.test(mimeType || '') && buffer.slice(0, 4).toString() !== '%PDF')
        return req.error(400, `Unsupported file type ${mimeType}. Upload an image (JPG/PNG) or PDF.`)

      const row = await processDocument({ fileName, mimeType, buffer })
      return SELECT.one.from(FormUploads, row.ID)
    })

    /** Mail channel: poll the inbox now (also used by POST /mail/poll) */
    this.on('pollMailbox', async () => {
      const r = await require('./lib/mail-inbox').pollOnce(processDocument)
      return { mails: r.mails || 0, attachments: r.attachments || 0, skipped: JSON.stringify(r) }
    })

    /* ----------------------------------------------------------- */
    /* Bound actions                                               */
    /* ----------------------------------------------------------- */
    this.on('extract', FormUploads, async req => { const ID = key(req); await stepExtract(ID); return SELECT.one.from(FormUploads, ID) })
    this.on('checkDuplicate', FormUploads, async req => { const ID = key(req); await stepDuplicateCheck(ID); return SELECT.one.from(FormUploads, ID) })
    this.on('createChangeRequest', FormUploads, async req => {
      const ID = key(req)
      const u = await SELECT.one.from(db.FormUploads, ID)
      if (u.duplicateFound) return req.error(409, `Business partner ${u.matchedPartner} already exists - no change request created (${u.matchReason})`)
      if (u.crNumber) return req.error(409, `Change request ${u.crNumber} was already created for this upload`)
      if (!u.name) return req.error(400, 'No name extracted - run the extraction first')
      if (!u.checkedAt) await stepDuplicateCheck(ID)
      const again = await SELECT.one.from(db.FormUploads, ID)
      if (again.duplicateFound) return req.error(409, `Duplicate found: BP ${again.matchedPartner}`)
      await stepCreateCR(ID, req.data.crType)
      await require('./lib/mail-inbox').notifyResult(await SELECT.one.from(db.FormUploads, ID),
        { userEmail: req.user?.attr?.email || req.user?.id }).catch(e => LOG.warn(e.message))
      return SELECT.one.from(FormUploads, ID)
    })
    this.on('reprocess', FormUploads, async req => {
      const ID = key(req)
      await DELETE.from(db.DuplicateCandidates).where({ upload_ID: ID })
      await UPDATE(db.FormUploads, ID).with({ crNumber: null, crType: null, crStatus: null, crCreatedAt: null, duplicateFound: false, matchedPartner: null, matchReason: null, checkedAt: null })
      await log(ID, 'Reprocess', 'OK', 'Process restarted by user', 0)
      await runProcess(ID, { autoCR: cds.env.mdgai?.s23?.autoCreateCR !== false })
      await require('./lib/mail-inbox').notifyResult(await SELECT.one.from(db.FormUploads, ID),
        { userEmail: req.user?.attr?.email || req.user?.id }).catch(e => LOG.warn(e.message))
      return SELECT.one.from(FormUploads, ID)
    })

    this.after('READ', FormUploads, rows => {
      const { crUrl } = require('./lib/mail-inbox')
      for (const r of Array.isArray(rows) ? rows : [rows]) {
        if (!r) continue
        if (r.status_code) r.statusCriticality = CRIT[r.status_code] ?? 0
        if ('crLink' in r) r.crLink = crUrl(r.crNumber)   // always current, also for older CRs
      }
    })

    this.on('config', () => ({
      s23Mode: s23.mode(),
      destination: cds.env.mdgai?.s23?.destination,
      crType: cds.env.mdgai?.s23?.crType,
      aiProvider: cds.env.mdgai?.ai?.provider
    }))

    // Start the e-mail inbox poller once the service is served
    cds.once('served', async () => {
      // Backfill running numbers for uploads created before seqNo existed (oldest = 1)
      try {
        const { FormUploads: FU } = mdgai()
        const open = await SELECT.from(FU).columns('ID').where({ seqNo: null }).orderBy('createdAt')
        if (open.length) {
          const last = await SELECT.one.from(FU).columns('max(seqNo) as m')
          let n = last?.m || 0
          for (const r of open) await UPDATE(FU, r.ID).with({ seqNo: ++n })
          LOG.info(`Numbered ${open.length} existing uploads`)
        }
      } catch (e) { LOG.warn('seqNo backfill failed:', e.message) }
      require('./lib/mail-inbox').startPoller(processDocument)
    })

    return super.init()
  }
}

module.exports.processDocument = (...a) => processDocument(...a)

/* =================================================================== */
/* Process steps                                                       */
/* =================================================================== */
const mdgai = () => cds.entities('mdgai')
const key = req => req.params?.[0]?.ID ?? req.params?.[0]

async function toBuffer (v) {
  if (!v) return Buffer.alloc(0)
  if (Buffer.isBuffer(v)) return v
  if (typeof v === 'string') return Buffer.from(v, 'base64')
  if (typeof v.pipe === 'function' || v[Symbol.asyncIterator]) {
    const chunks = []; for await (const c of v) chunks.push(Buffer.from(c)); return Buffer.concat(chunks)
  }
  return Buffer.from(v)
}

async function log (upload_ID, step, result, details, criticality = 0) {
  const { ProcessingLog } = mdgai()
  const last = await SELECT.one.from(ProcessingLog).columns('max(seq) as m').where({ upload_ID })
  await INSERT.into(ProcessingLog).entries({ upload_ID, seq: (last?.m || 0) + 1, step, result, details: String(details).slice(0, 1000), criticality, timestamp: new Date().toISOString() })
}

async function setStatus (ID, code, extra = {}) {
  await UPDATE(mdgai().FormUploads, ID).with({ status_code: code, statusCriticality: CRIT[code], ...extra })
}

/**
 * Common entry for UI upload and e-mail: store file, extract, duplicate check, create CR.
 * Returns the FormUploads row (incl. status, crNumber, matchedPartner).
 */
async function processDocument ({ fileName, mimeType, buffer, mailMeta = {} }) {
  const { FormUploads } = mdgai()
  const ID = cds.utils.uuid()
  const last = await SELECT.one.from(FormUploads).columns('max(seqNo) as m')
  await INSERT.into(FormUploads).entries({
    ID, seqNo: (last?.m || 0) + 1,
    fileName, mimeType, content: buffer, status_code: 'UPLOADED', statusCriticality: 0,
    previewUrl: `/files/${ID}/preview`, source: 'UI', ...mailMeta
  })
  const origin = mailMeta.source === 'EMAIL' ? `e-mail from ${mailMeta.mailFrom} ("${mailMeta.mailSubject || ''}")` : 'upload'
  await log(ID, mailMeta.source === 'EMAIL' ? 'Received by e-mail' : 'Upload picture in SAP CAP', 'OK',
    `${fileName} (${mimeType}, ${Math.round(buffer.length / 1024)} KB) stored - ${origin}`, 3)
  await runProcess(ID, { autoCR: cds.env.mdgai?.s23?.autoCreateCR !== false })

  // Automatic result mail after AI check (duplicate / CR created / error) - UI and e-mail
  const row = await SELECT.one.from(FormUploads, ID)
  const user = cds.context?.user
  const userEmail = user?.attr?.email || user?.tokenInfo?.getPayload?.()?.email || user?.id
  try {
    await require('./lib/mail-inbox').notifyResult(row, { userEmail })
    await log(ID, 'Result notification', 'OK', (await SELECT.one.from(FormUploads, ID).columns('replyStatus'))?.replyStatus || '-', 3)
  } catch (e) {
    await log(ID, 'Result notification', 'WARNING', e.message, 2)
  }
  return SELECT.one.from(FormUploads, ID)
}

async function runProcess (ID, { autoCR }) {
  try {
    await stepExtract(ID)
    const dup = await stepDuplicateCheck(ID)
    if (!dup && autoCR) await stepCreateCR(ID)
  } catch (e) {
    LOG.error(e)
    await setStatus(ID, 'ERROR', { message: e.message })
    await log(ID, 'Process', 'ERROR', e.message, 1)
  }
}

/* Step 2a - AI reads the image */
async function stepExtract (ID) {
  const { FormUploads } = mdgai()
  const u = await SELECT.one.from(FormUploads, ID).columns('content', 'mimeType', 'fileName')
  const r = await extractor.extract(await toBuffer(u.content), u.mimeType)
  await setStatus(ID, 'EXTRACTED', {
    extractionMethod: r.method, extractionNote: r.note, rawText: r.rawText, preview: r.preview,
    bpCategory: r.bpCategory, name: r.name, street: r.street, houseNumber: r.houseNumber,
    postalCode: r.postalCode, city: r.city, country: r.country, taxType: r.taxType, taxNumber: r.taxNumber,
    message: `Extracted: ${r.name || '?'} | ${r.street} ${r.houseNumber}, ${r.postalCode} ${r.city} ${r.country} | Tax: ${r.taxNumber || '-'}`
  })
  const missing = ['name', 'street', 'postalCode', 'city'].filter(f => !r[f])
  await log(ID, 'AI extraction', missing.length ? 'WARNING' : 'OK',
    `${r.method}. Name="${r.name}", Address="${r.street} ${r.houseNumber}, ${r.postalCode} ${r.city}, ${r.country}", Tax="${r.taxNumber || '(empty)'}"` + (missing.length ? `. Missing: ${missing.join(', ')}` : ''),
    missing.length ? 2 : 3)
  return r
}

/* Step 2b - duplicate check BUT000 / ADRC / DFKKBPTAXNUM */
async function stepDuplicateCheck (ID) {
  const { FormUploads, DuplicateCandidates } = mdgai()
  const form = await SELECT.one.from(FormUploads, ID)
  const { candidates, source } = await s23.findCandidates(form)
  const results = matching.evaluate(form, candidates)

  await DELETE.from(DuplicateCandidates).where({ upload_ID: ID })
  if (results.length) await INSERT.into(DuplicateCandidates).entries(results.map(r => ({ ...r, upload_ID: ID })))

  const dup = results.find(r => r.isDuplicate)
  const checkedAt = new Date().toISOString()
  if (dup) {
    const msg = `Notification for existing duplicate: Business partner ${dup.partner} (${dup.partnerName}) already exists in S23 - ${dup.rule}. No change request created.`
    await setStatus(ID, 'DUPLICATE', { duplicateFound: true, matchedPartner: dup.partner, matchReason: dup.rule, checkedAt, message: msg })
    await log(ID, 'Duplicate check', 'DUPLICATE', `${source}: ${msg}`, 1)
    return dup
  }
  const partial = results.length ? ` Partial hits (not duplicates): ${results.map(r => `${r.partner} [${r.rule}]`).join('; ')}.` : ''
  await setStatus(ID, 'NO_MATCH', { duplicateFound: false, matchedPartner: null, matchReason: 'No match on name+address or tax number', checkedAt, message: 'No business partner exists for this customer - change request can be created in MDG.' + partial })
  await log(ID, 'Duplicate check', 'NO MATCH', `${source}: no BP with identical name+address and no tax number match.${partial}`, 3)
  return null
}

/* Step 3 - Auto. creation of CR with prefilled data in MDG */
async function stepCreateCR (ID, crTypeParam) {
  const { FormUploads } = mdgai()
  const form = await SELECT.one.from(FormUploads, ID)
  const crType = crTypeParam || cds.env.mdgai?.s23?.crType || 'ZBP1P1'
  const r = await s23.createChangeRequest(form, crType)
  if (r.fallbackFrom) await log(ID, 'CR type fallback', 'WARNING', `CR type ${r.fallbackFrom} rejected (${r.fallbackReason}) - used ${r.crType}`, 2)
  const now = new Date().toISOString()
  if (r.messageId && !r.crNumber) {
    // SOA inbound is asynchronous: MDG creates the CR in the background
    await setStatus(ID, 'CR_CREATED', {
      crNumber: 'pending', crType: r.crType, crStatus: r.crStatus, crCreatedAt: now,
      message: `Business partner sent to MDG via SOA service (MessageID ${r.messageId}). MDG creates the change request ` +
               `asynchronously with the default CR type of business activity BPPI - check "My Change Requests" / USMD120C.`
    })
    await log(ID, 'Auto. creation of CR in MDG', 'OK', `Sent to ${r.target}. CR is created asynchronously by MDG.`, 3)
    return
  }
  await setStatus(ID, 'CR_CREATED', {
    crNumber: r.crNumber, crType: r.crType, crStatus: r.crStatus, crCreatedAt: now,
    message: `MDG change request ${r.crNumber} (type ${r.crType}) created in ${r.target} with prefilled name, address and tax number.`
  })
  await log(ID, 'Auto. creation of CR in MDG', 'OK', `CR ${r.crNumber}, type ${r.crType}, status ${r.crStatus} (${r.target})`, 3)
}
