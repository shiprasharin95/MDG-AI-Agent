/**
 * End-to-end test with the 4 sample forms from the requirement document.
 *   npm test
 */
const cds = require('@sap/cds')
const fs = require('fs')
const path = require('path')
const { test } = require('node:test')
const assert = require('node:assert')

const DIR = [path.join(__dirname, '..', 'samples'), path.join(__dirname, '..', '..', 'requiment document')].find(d => fs.existsSync(d))
const EXPECT = {
  'Dokument MDG AI - BP Existing (no VAT).pdf': { status: 'DUPLICATE', partner: '1000040' },   // name + address identical
  'Dokument MDG AI - BP Existing (VAT).pdf': { status: 'DUPLICATE', partner: '1000040' },      // name + address & tax
  'Dokument MDG AI - no BP Existing (no VAT).pdf': { status: 'CR_CREATED' },                   // no match -> CR in MDG
  'Dokument MDG AI - no BP Existing (VAT).pdf': { status: 'DUPLICATE', partner: '1000040' }    // tax DE811218846 belongs to BP 1000040
}

const { POST, GET, axios } = cds.test(path.join(__dirname, '..'))
axios.defaults.auth = { username: 'test', password: 'test' }

for (const [file, exp] of Object.entries(EXPECT)) {
  test(file, { skip: !fs.existsSync(path.join(DIR, file)) && 'sample missing' }, async () => {
    const { data } = await POST('/odata/v4/mdg-ai/uploadForm', {
      fileName: file, mimeType: 'application/pdf', content: fs.readFileSync(path.join(DIR, file)).toString('base64')
    })
    if (data.status_code === 'ERROR') console.log('ERROR MESSAGE:', data.message)
    console.log(`  -> ${data.status_code} | ${data.name} | ${data.street} ${data.houseNumber}, ${data.postalCode} ${data.city} ${data.country} | tax=${data.taxNumber || '-'} | BP=${data.matchedPartner || '-'} | CR=${data.crNumber || '-'}\n     ${data.message}`)
    assert.strictEqual(data.status_code, exp.status, `${data.status_code}: ${data.message}`)
    if (exp.partner) assert.strictEqual(data.matchedPartner, exp.partner)
    if (exp.status === 'CR_CREATED') assert.ok(data.crNumber)
  })
}

test('image upload (PNG photo of form) goes through OCR', async () => {
  const { render } = require('../srv/lib/extractor')
  const pdf = fs.readFileSync(path.join(DIR, 'Dokument MDG AI - BP Existing (no VAT).pdf'))
  const { png } = await render(pdf, 'application/pdf')
  const { data } = await POST('/odata/v4/mdg-ai/uploadForm', { fileName: 'photo.png', mimeType: 'image/png', content: png.toString('base64') })
  assert.match(data.extractionMethod, /OCR|AI Core/)
  assert.strictEqual(data.status_code, 'DUPLICATE', `${data.status_code}: ${data.message}`)
  assert.strictEqual(data.matchedPartner, '1000040')
})

test('createChangeRequest is refused for duplicates', async () => {
  const { data } = await GET(`/odata/v4/mdg-ai/FormUploads?$filter=status_code eq 'DUPLICATE'&$top=1`)
  await assert.rejects(POST(`/odata/v4/mdg-ai/FormUploads(${data.value[0].ID})/MdgAiService.createChangeRequest`, { crType: 'BP1P1' }), /already exists|409/)
})

test('duplicate candidates and log are exposed', async () => {
  const { data } = await GET('/odata/v4/mdg-ai/FormUploads?$expand=matches,log')
  assert.ok(data.value.length >= 1)
  assert.ok(data.value.some(u => u.log.length >= 3))
})
