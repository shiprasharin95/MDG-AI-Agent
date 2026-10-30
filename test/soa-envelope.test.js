const { test } = require('node:test')
const assert = require('node:assert')
const { buildEnvelope } = require('../srv/lib/soa-bp')

test('SOA envelope - organization with tax number', () => {
  const { envelope, msgId } = buildEnvelope({
    name: 'BearingPoint GmbH', bpCategory: '2', street: 'Speicherstraße', houseNumber: '1',
    postalCode: '60327', city: 'Frankfurt', country: 'DE', taxNumber: 'DE811218846', taxType: 'DE0'
  })
  assert.ok(msgId)
  assert.match(envelope, /BusinessPartnerSUITEBulkReplicateRequest/)
  assert.match(envelope, /<FirstLineName>BearingPoint GmbH<\/FirstLineName>/)
  assert.match(envelope, /<StreetName>Speicherstraße<\/StreetName>/)
  assert.match(envelope, /<PartyTaxID>DE811218846<\/PartyTaxID>/)
  assert.doesNotMatch(envelope, /<Person>/)
})

test('SOA envelope - person, no tax, XML escaping', () => {
  const { envelope } = buildEnvelope({
    name: 'Otto Willy', bpCategory: '1', street: 'Test & Str.', houseNumber: '1',
    postalCode: '12345', city: 'Testhausen', country: 'DE'
  })
  assert.match(envelope, /<GivenName>Otto<\/GivenName>/)
  assert.match(envelope, /<FamilyName>Willy<\/FamilyName>/)
  assert.match(envelope, /<StreetName>Test &amp; Str.<\/StreetName>/)
  assert.doesNotMatch(envelope, /<TaxNumber/)
})
