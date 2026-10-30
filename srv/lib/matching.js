/**
 * Duplicate rules from the functional spec:
 *   Duplicate  <=>  (name identical AND address identical)  OR  (tax number identical)
 *
 * "identical" is evaluated on normalised values so that form spelling variants
 * (Speicherstr. vs Speicherstraße, Frankfurt vs Frankfurt am Main, case, spaces,
 * punctuation) do not prevent a match.
 */
const UMLAUT = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }

const base = (s = '') => String(s).toLowerCase()
  .replace(/[äöüß]/g, c => UMLAUT[c])
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')

const normName = s => base(s).replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')

const normStreet = s => base(s)
  .replace(/\bstr\.?(?=\s|$)/g, 'strasse')
  .replace(/str\.?$/g, 'strasse')
  .replace(/strasse\b/g, 'strasse')
  .replace(/[^a-z0-9]/g, '')

const normHouse = s => base(s).replace(/[^a-z0-9]/g, '')
const normPostal = s => String(s || '').replace(/\s+/g, '').toUpperCase()
const normCity = s => base(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
const normTax = s => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()

function cityCompatible (a, b) {
  const x = normCity(a), y = normCity(b)
  if (!x || !y) return false
  return x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ')
}

function nameMatches (form, bp) {
  const f = normName(form.name)
  if (!f) return false
  const candidates = [
    [bp.NAME_ORG1, bp.NAME_ORG2].filter(Boolean).join(' '),
    bp.NAME_ORG1,
    [bp.NAME_FIRST, bp.NAME_LAST].filter(Boolean).join(' '),
    [bp.NAME_LAST, bp.NAME_FIRST].filter(Boolean).join(' ')
  ].map(normName).filter(Boolean)
  return candidates.includes(f)
}

function addressMatches (form, adr) {
  if (!adr) return false
  if (!form.street || !form.postalCode) return false
  const streetOk = normStreet(form.street) === normStreet(adr.STREET)
  const houseOk = normHouse(form.houseNumber) === normHouse(adr.HOUSE_NUM1)
  const postalOk = normPostal(form.postalCode) === normPostal(adr.POST_CODE1)
  const cityOk = !form.city || cityCompatible(form.city, adr.CITY1)
  const countryOk = !form.country || !adr.COUNTRY || form.country === adr.COUNTRY
  return streetOk && houseOk && postalOk && cityOk && countryOk
}

function taxMatches (form, taxes = []) {
  const t = normTax(form.taxNumber)
  if (!t) return false
  return taxes.some(x => normTax(x.TAXNUM) === t || normTax(x.TAXNUMXL) === t)
}

/**
 * @param form       extracted data
 * @param candidates [{ bp: BUT000, adr: ADRC, taxes: DFKKBPTAXNUM[] }]
 */
function evaluate (form, candidates) {
  return candidates.map(({ bp, adr, taxes }) => {
    const nameMatch = nameMatches(form, bp)
    const addressMatch = addressMatches(form, adr)
    const taxMatch = taxMatches(form, taxes)
    const isDuplicate = (nameMatch && addressMatch) || taxMatch
    const rule = isDuplicate
      ? [taxMatch && 'Tax number matches (DFKKBPTAXNUM)', nameMatch && addressMatch && 'Name + address identical (BUT000/ADRC)'].filter(Boolean).join(' & ')
      : [nameMatch && 'name only', addressMatch && 'address only'].filter(Boolean).join(', ') || 'no match'
    return {
      partner: bp.PARTNER,
      partnerName: [bp.NAME_ORG1, bp.NAME_ORG2, bp.NAME_FIRST, bp.NAME_LAST].filter(Boolean).join(' '),
      address: adr ? `${adr.STREET || ''} ${adr.HOUSE_NUM1 || ''}, ${adr.POST_CODE1 || ''} ${adr.CITY1 || ''}, ${adr.COUNTRY || ''}`.replace(/\s+/g, ' ').trim() : '',
      taxNumber: (taxes || []).map(t => t.TAXNUM || t.TAXNUMXL).filter(Boolean).join(', '),
      nameMatch, addressMatch, taxMatch, isDuplicate, rule,
      criticality: isDuplicate ? 1 : (nameMatch || addressMatch ? 2 : 0)
    }
  }).filter(c => c.nameMatch || c.addressMatch || c.taxMatch)
    .sort((a, b) => (b.isDuplicate - a.isDuplicate) || ((b.nameMatch + b.addressMatch + b.taxMatch) - (a.nameMatch + a.addressMatch + a.taxMatch)))
}

module.exports = { evaluate, normName, normStreet, normPostal, normTax, nameMatches, addressMatches, taxMatches }
