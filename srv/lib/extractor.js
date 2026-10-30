/**
 * Step 2a - AI extraction of business partner data from an uploaded form.
 *
 * Strategy (cds.env.mdgai.ai.provider):
 *  - 'aicore' : SAP AI Core / Generative AI Hub (Orchestration, vision LLM)
 *  - 'local'  : PDF text layer, otherwise local OCR (tesseract.js)
 *  - 'auto'   : AI Core if credentials are bound (AICORE_SERVICE_KEY / VCAP), else local
 *
 * Output is always normalised to:
 *  { name, bpCategory, street, houseNumber, postalCode, city, country, taxNumber, taxType, rawText, method, note }
 */
const cds = require('@sap/cds')
const LOG = cds.log('mdgai-ai')

const PROMPT = `You are an SAP Master Data Governance assistant.
The image is a hand-filled or printed customer registration form.
Extract the business partner data and answer ONLY with JSON:
{
 "name": string,                // full name or company name exactly as written
 "bpCategory": "1"|"2",         // 1 = natural person, 2 = organization (GmbH, AG, SE, Ltd, Inc ...)
 "street": string,              // street name only, expand abbreviations e.g. "Speicherstr." -> "Speicherstraße"
 "houseNumber": string,
 "postalCode": string,
 "city": string,
 "country": string,             // ISO 3166 alpha-2, derive from postal code / tax number / city if missing
 "taxNumber": string            // VAT / tax number, "" if empty
}
Never invent values - leave unknown fields as "".`

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */
async function pdfToText (buffer) {
  const { PDFParse } = require('pdf-parse')
  const p = new PDFParse({ data: buffer })
  try {
    const r = await p.getText()
    return (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').trim()
  } finally { await p.destroy?.() }
}

async function pdfToPng (buffer) {
  const { PDFParse } = require('pdf-parse')
  const p = new PDFParse({ data: buffer })
  try {
    const r = await p.getScreenshot({ scale: 1.5, imageBuffer: true, imageDataUrl: false, first: 1 })
    return Buffer.from(r.pages[0].data)
  } finally { await p.destroy?.() }
}

async function ocr (pngOrJpg) {
  const Tesseract = require('tesseract.js')
  const worker = await Tesseract.createWorker(cds.env.mdgai?.ai?.ocrLanguages || 'deu+eng')
  try {
    const { data } = await worker.recognize(pngOrJpg)
    return data.text || ''
  } finally { await worker.terminate() }
}

/* ------------------------------------------------------------------ */
/* Rule-based parser for "Name: / Adress: / Tax:" style forms          */
/* ------------------------------------------------------------------ */
const STREET_ABBR = [
  [/str\.?$/i, 'straße'], [/strasse$/i, 'straße'], [/Str\.?$/, 'Straße'], [/pl\.?$/i, 'platz'], [/allee$/i, 'allee']
]
const ORG_HINTS = /\b(gmbh|ag|se|kg|ohg|ug|e\.?v\.?|ltd|limited|inc|corp|llc|s\.?a\.?|b\.?v\.?|plc|co\.?\s*kg|holding|group)\b/i

function expandStreet (s = '') {
  s = s.trim()
  for (const [re, rep] of STREET_ABBR) if (re.test(s)) return s.replace(re, m => (m[0] === 'S' ? 'Straße' : rep))
  return s
}

function countryFrom ({ taxNumber, postalCode, explicit }) {
  if (explicit && /^[A-Z]{2}$/i.test(explicit)) return explicit.toUpperCase()
  const m = /^([A-Z]{2})\d/.exec((taxNumber || '').toUpperCase())
  if (m && m[1] !== 'EL') return m[1]
  if (/^\d{5}$/.test(postalCode || '')) return 'DE'
  return ''
}

function parseFormText (text = '') {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const get = re => { const l = lines.find(x => re.test(x)); return l ? l.replace(re, '').trim() : '' }

  const name = get(/^(name|firma|company|kunde|customer)\s*[:\-]\s*/i)
  const addr = get(/^(add?ress?e?|anschrift|adresse)\s*[:\-]\s*/i)
  const tax = get(/^(tax|vat|ust\.?-?id(nr)?\.?|steuer(nummer)?|tax\s*(no|number|id))\s*[:\-]?\s*/i)
  const countryExplicit = get(/^(country|land)\s*[:\-]\s*/i)

  let street = '', houseNumber = '', postalCode = '', city = ''
  if (addr) {
    const [streetPart, ...rest] = addr.split(',').map(s => s.trim())
    const sm = /^(.*?)[\s]+(\d+\s*[a-zA-Z]?(?:\s*[-/]\s*\d+[a-zA-Z]?)?)$/.exec(streetPart || '')
    if (sm) { street = sm[1]; houseNumber = sm[2].replace(/\s+/g, '') } else street = streetPart || ''
    const cityPart = rest.join(' ').trim()
    const cm = /(\d{4,5})\s+(.+)$/.exec(cityPart)
    if (cm) { postalCode = cm[1]; city = cm[2].trim() } else city = cityPart
  }
  const taxNumber = (tax || '').replace(/\s+/g, '').toUpperCase()
  return {
    name,
    bpCategory: ORG_HINTS.test(name) ? '2' : (name ? '1' : '2'),
    street: expandStreet(street),
    houseNumber,
    postalCode,
    city,
    country: countryFrom({ taxNumber, postalCode, explicit: countryExplicit }),
    taxNumber
  }
}

/* ------------------------------------------------------------------ */
/* SAP AI Core (Generative AI Hub - Orchestration)                     */
/* ------------------------------------------------------------------ */
function aiCoreAvailable () {
  if (process.env.AICORE_SERVICE_KEY) return true
  try { return !!JSON.parse(process.env.VCAP_SERVICES || '{}').aicore } catch { return false }
}

async function extractWithAiCore (imageBuffer, mime, hintText) {
  const { OrchestrationClient } = require('@sap-ai-sdk/orchestration')
  const cfg = cds.env.mdgai?.ai || {}
  const client = new OrchestrationClient(
    { promptTemplating: { model: { name: cfg.model || 'gpt-4o', params: { temperature: 0 } } } },
    { resourceGroup: cfg.resourceGroup || 'default' }
  )
  const dataUrl = `data:${mime};base64,${imageBuffer.toString('base64')}`
  const res = await client.chatCompletion({
    messages: [
      { role: 'system', content: PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: hintText ? `Text layer of the document (may help):\n${hintText}` : 'Extract the data from this form.' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
  })
  const out = res.getContent() || ''
  const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  return { ...json, rawText: out }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */
async function render (buffer, mimeType) {
  const isPdf = /pdf/i.test(mimeType) || buffer.slice(0, 4).toString() === '%PDF'
  if (isPdf) return { isPdf, png: await pdfToPng(buffer), pngMime: 'image/png' }
  return { isPdf, png: buffer, pngMime: mimeType || 'image/png' }
}

async function extract (buffer, mimeType) {
  const provider = cds.env.mdgai?.ai?.provider || 'auto'
  const { isPdf, png, pngMime } = await render(buffer, mimeType)
  const textLayer = isPdf ? await pdfToText(buffer).catch(() => '') : ''

  const useAiCore = provider === 'aicore' || (provider === 'auto' && aiCoreAvailable())
  if (useAiCore) {
    try {
      const r = await extractWithAiCore(png, pngMime, textLayer)
      const n = normalise(r)
      return { ...n, rawText: textLayer || r.rawText, method: `SAP AI Core (${cds.env.mdgai?.ai?.model || 'gpt-4o'})`, note: 'Vision LLM via Generative AI Hub orchestration', preview: png }
    } catch (e) {
      LOG.warn('AI Core extraction failed, falling back to local OCR:', e.message)
      if (provider === 'aicore') throw e
    }
  }

  let rawText = textLayer, method = 'PDF text layer + rule parser'
  if (!rawText || rawText.length < 5) { rawText = await ocr(png); method = 'Local OCR (tesseract) + rule parser' }
  return { ...normalise(parseFormText(rawText)), rawText, method, note: useAiCore ? 'AI Core failed - used local fallback' : 'AI Core not bound - local extraction', preview: png }
}

function normalise (r = {}) {
  const taxNumber = String(r.taxNumber || '').replace(/\s+/g, '').toUpperCase()
  const postalCode = String(r.postalCode || '').trim()
  return {
    name: String(r.name || '').trim(),
    bpCategory: r.bpCategory === '1' ? '1' : (r.bpCategory === '2' ? '2' : (ORG_HINTS.test(r.name || '') ? '2' : '1')),
    street: expandStreet(String(r.street || '')),
    houseNumber: String(r.houseNumber || '').trim(),
    postalCode,
    city: String(r.city || '').trim(),
    country: countryFrom({ taxNumber, postalCode, explicit: r.country }),
    taxNumber,
    taxType: taxNumber ? (/^[A-Z]{2}/.test(taxNumber) ? `${taxNumber.slice(0, 2)}0` : 'DE2') : ''
  }
}

module.exports = { extract, parseFormText, normalise, render }
