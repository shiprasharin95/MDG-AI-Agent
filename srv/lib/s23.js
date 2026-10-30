/**
 * Connector to S23 (client 120).
 *
 *  mode = 'mock'   -> local tables s23.BUT000 / s23.ADRC / s23.DFKKBPTAXNUM / s23.MDG_CR
 *  mode = 'remote' -> BTP destination (default 'S23_120')
 *       duplicate check : API_BUSINESS_PARTNER (A2X) - reads BUT000 / ADRC / DFKKBPTAXNUM
 *       CR creation     : ZMDG_BP_CR_SRV (custom OData wrapping CL_USMD_GOV_API, see abap/)
 *
 * Both modes return candidates in the SAP table layout so that matching.js is
 * identical for mock and real system.
 */
const cds = require('@sap/cds')
const LOG = cds.log('mdgai-s23')
const { normName, normPostal, normTax } = require('./matching')

const cfg = () => cds.env.mdgai?.s23 || {}
const mode = () => (process.env.S23_MODE || cfg().mode || 'mock')

/* ================================================================== */
/* MOCK                                                               */
/* ================================================================== */
const mock = {
  async findCandidates (form) {
    const { BUT000, ADRC, DFKKBPTAXNUM } = cds.entities('s23')
    const tax = normTax(form.taxNumber)
    const nameKey = normName(form.name).split(' ')[0] || '#'
    const postal = normPostal(form.postalCode)

    // SQL pre-selection (like the real system would do with indexes)
    const byTax = tax ? await SELECT.from(DFKKBPTAXNUM).columns('PARTNER').where`upper(TAXNUM) = ${tax} or upper(TAXNUMXL) = ${tax}` : []
    const byAdr = postal ? await SELECT.from(ADRC).columns('ADDRNUMBER').where({ POST_CODE1: postal }) : []
    const all = await SELECT.from(BUT000)
    const byName = all.filter(b => normName([b.NAME_ORG1, b.NAME_ORG2, b.NAME_FIRST, b.NAME_LAST].join(' ')).includes(nameKey))

    const ids = new Set([
      ...byTax.map(r => r.PARTNER),
      ...byName.map(r => r.PARTNER),
      ...all.filter(b => byAdr.some(a => a.ADDRNUMBER === b.ADDRNUMBER)).map(b => b.PARTNER)
    ])
    const out = []
    for (const id of ids) {
      const bp = all.find(b => b.PARTNER === id)
      if (!bp) continue
      const adr = bp.ADDRNUMBER ? await SELECT.one.from(ADRC).where({ ADDRNUMBER: bp.ADDRNUMBER }) : null
      const taxes = await SELECT.from(DFKKBPTAXNUM).where({ PARTNER: id })
      out.push({ bp, adr, taxes })
    }
    return { candidates: out, source: 'S23 mock tables BUT000 / ADRC / DFKKBPTAXNUM' }
  },

  async createChangeRequest (form, crType) {
    const { MDG_CR } = cds.entities('s23')
    const last = await SELECT.one.from(MDG_CR).columns('max(USMD_CREQUEST) as max')
    const next = String((parseInt(last?.max || '1000', 10) || 1000) + 1).padStart(6, '0')
    const isPerson = form.bpCategory === '1'
    const [first, ...lastParts] = (form.name || '').split(' ')
    const cr = {
      USMD_CREQUEST: next,
      USMD_CREQ_TYPE: crType,
      USMD_CREQ_TEXT: `AI upload: ${form.name}`.slice(0, 60),
      USMD_CREQ_STATUS: '01',
      BP_TEMP_ID: '$1',
      NAME_ORG1: isPerson ? '' : (form.name || '').slice(0, 40),
      NAME_FIRST: isPerson ? first : '',
      NAME_LAST: isPerson ? lastParts.join(' ') : '',
      STREET: form.street, HOUSE_NUM1: form.houseNumber, POST_CODE1: form.postalCode, CITY1: form.city, COUNTRY: form.country,
      TAXTYPE: form.taxType || '', TAXNUM: form.taxNumber || '',
      CREATED_AT: new Date().toISOString()
    }
    await INSERT.into(MDG_CR).entries(cr)
    return { crNumber: next, crType, crStatus: '01 - Changes to be executed', target: 'S23 mock (MDG staging simulated)' }
  }
}

/* ================================================================== */
/* REMOTE (BTP destination -> S23 client 120)                          */
/* ================================================================== */
/** Destination name; can be overridden at runtime:
 *  cf set-env mdg-ai-bp-srv S23_DESTINATION S23_client_120   (principal propagation)
 *  cf set-env mdg-ai-bp-srv S23_DESTINATION S23_120_BASIC    (basic authentication) */
const destName = () => process.env.S23_DESTINATION || cfg().destination || 'S23_120_BASIC'

const remote = {
  async http (opts) {
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
    const c = cfg()
    const destinationName = destName()
    // For PrincipalPropagation destinations the logged-in user's JWT must be forwarded.
    // For BasicAuthentication it is ignored, so we always pass it when available.
    const auth = cds.context?.http?.req?.headers?.authorization || ''
    const jwt = auth.replace(/^Bearer\s+/i, '') || undefined
    // Build a fully encoded URL ourselves: OData $filter values contain spaces and quotes
    // ("BPTaxNumber eq 'DE811218846'"), which the HTTP client rejects as "unescaped characters".
    const params = { 'sap-client': c.sapClient || '120', ...(opts.params || {}) }
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k).replace(/%24/g, '$')}=${encodeURIComponent(v)}`)
      .join('&')
    const path = opts.url.split('/').map(seg => encodeURI(seg).replace(/'/g, '%27')).join('/')
    const { params: _ignored, soap, ...rest } = opts
    try {
      const res = await executeHttpRequest(
        { destinationName, ...(jwt ? { jwt } : {}) },
        { ...rest, url: `${path}?${query}`, headers: { ...(soap ? {} : { Accept: 'application/json' }), ...(opts.headers || {}) } },
        // SOAP services (SOAMANAGER) do not use the OData CSRF token handshake
        { fetchCsrfToken: !soap && opts.method && opts.method !== 'GET' }
      )
      return res.data
    } catch (e) {
      // Surface the real SAP Gateway message instead of "Request failed with status code 400"
      const d = e.response?.data
      const sap = d?.error?.message?.value || d?.error?.message || d?.['odata.error']?.message?.value ||
                  (typeof d === 'string' ? d.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) : '')
      const err = new Error(`${opts.method || 'GET'} ${opts.url} -> ${e.response?.status || '?'}${sap ? `: ${sap}` : `: ${e.message}`}`)
      err.status = e.response?.status
      throw err
    }
  },
  rows: d => d?.d?.results || d?.value || [],

  /** Map API_BUSINESS_PARTNER result -> BUT000 / ADRC / DFKKBPTAXNUM layout */
  toTables (bp) {
    const a = (bp.to_BusinessPartnerAddress?.results || [])[0]
    return {
      bp: {
        PARTNER: bp.BusinessPartner, TYPE: bp.BusinessPartnerCategory, BU_GROUP: bp.BusinessPartnerGrouping,
        NAME_ORG1: bp.OrganizationBPName1, NAME_ORG2: bp.OrganizationBPName2,
        NAME_FIRST: bp.FirstName, NAME_LAST: bp.LastName, ADDRNUMBER: a?.AddressID
      },
      adr: a ? { ADDRNUMBER: a.AddressID, STREET: a.StreetName, HOUSE_NUM1: a.HouseNumber, POST_CODE1: a.PostalCode, CITY1: a.CityName, COUNTRY: a.Country } : null,
      taxes: (bp.to_BusinessPartnerTax?.results || []).map(t => ({ PARTNER: t.BusinessPartner, TAXTYPE: t.BPTaxType, TAXNUM: t.BPTaxNumber, TAXNUMXL: t.BPTaxLongNumber }))
    }
  },

  async findCandidates (form) {
    const base = cfg().bpServicePath || '/sap/opu/odata/sap/API_BUSINESS_PARTNER'
    const q = s => String(s).replace(/'/g, "''")
    const ids = new Set()

    // DFKKBPTAXNUM
    const tax = normTax(form.taxNumber)
    if (tax) {
      const r = await this.http({ method: 'GET', url: `${base}/A_BusinessPartnerTaxNumber`, params: { $filter: `BPTaxNumber eq '${q(tax)}'`, $select: 'BusinessPartner', $format: 'json' } })
      this.rows(r).forEach(x => ids.add(x.BusinessPartner))
    }
    // BUT000 (name) - search on the first significant word, exact compare later
    const word = (form.name || '').split(/\s+/).find(w => w.length > 2)
    if (word) {
      const f = form.bpCategory === '1'
        ? `substringof('${q(word)}',LastName) or substringof('${q(word)}',FirstName)`
        : `substringof('${q(word)}',OrganizationBPName1)`
      const r = await this.http({ method: 'GET', url: `${base}/A_BusinessPartner`, params: { $filter: f, $select: 'BusinessPartner', $top: '50', $format: 'json' } })
      this.rows(r).forEach(x => ids.add(x.BusinessPartner))
    }
    // ADRC (address): postal code + street, so we don't pull every BP of a city
    if (form.postalCode) {
      const f = [`PostalCode eq '${q(form.postalCode)}'`]
      if (form.street) f.push(`substringof('${q(form.street.slice(0, 10))}',StreetName)`)
      const r = await this.http({ method: 'GET', url: `${base}/A_BusinessPartnerAddress`, params: { $filter: f.join(' and '), $select: 'BusinessPartner', $top: '50', $format: 'json' } })
      this.rows(r).forEach(x => ids.add(x.BusinessPartner))
    }

    // Read the details in parallel (max 20) - sequential calls ran into the gateway timeout
    const details = await Promise.all([...ids].slice(0, 20).map(id =>
      this.http({ method: 'GET', url: `${base}/A_BusinessPartner('${q(id)}')`, params: { $expand: 'to_BusinessPartnerAddress,to_BusinessPartnerTax', $format: 'json' } })
        .then(r => this.toTables(r.d || r))
        .catch(e => { LOG.warn(`BP ${id} could not be read: ${e.message}`); return null })
    ))
    const out = details.filter(Boolean)
    return { candidates: out, source: `S23 via destination ${cfg().destination} (API_BUSINESS_PARTNER)` }
  },

  async createChangeRequest (form, crType) {
    // Option 3: standard SAP SOA inbound service, MDG creates the CR itself
    if ((process.env.S23_CR_METHOD || cfg().crMethod) === 'soa') {
      const name = (form.name || '').trim()
      const missing = [['name', name], ['street', form.street], ['postal code', form.postalCode], ['city', form.city], ['country', form.country]]
        .filter(([, v]) => !v).map(([k]) => k)
      if (missing.length) throw new Error(`Cannot create change request - the AI could not read: ${missing.join(', ')}`)
      const bpCategory = (form.bpCategory === '1' && name.split(/\s+/).length >= 2) ? '1' : '2'
      return require('./soa-bp').createViaSoa({ ...form, name, bpCategory }, opts => this.http(opts), { ...cfg(), crType })
    }
    // Option B: custom OData ZMDG_BP_CR_SRV (ABAP class ZCL_MDG_BP_CR_CREATE)
    // S23_CR_SERVICE overrides at runtime, e.g. /sap/opu/odata/sap/ZMDG_BP_CR_TEST_SRV
    // (colleague's tested service, class ZCL_MDG_BP_TEST_CR_CREATE)
    const base = process.env.S23_CR_SERVICE || cfg().crServicePath || '/sap/opu/odata/sap/ZMDG_BP_CR_SRV'
    const name = (form.name || '').trim()
    // A person needs first AND last name in MDG - a single word becomes an organization
    const bpCategory = (form.bpCategory === '1' && name.split(/\s+/).length >= 2) ? '1' : '2'
    const body = {
      CrNumber: '', CrStatus: '', BpTemp: '', Message: '',
      CrType: crType,
      Description: `AI upload: ${name}`.slice(0, 60),
      BpCategory: bpCategory,
      Name: name, Street: form.street || '', HouseNumber: form.houseNumber || '',
      PostalCode: form.postalCode || '', City: form.city || '', Country: form.country || '',
      TaxType: form.taxType || '', TaxNumber: form.taxNumber || ''
    }
    const missing = ['Name', 'Street', 'PostalCode', 'City', 'Country'].filter(f => !body[f])
    if (missing.length) {
      throw new Error(`Cannot create change request - the AI could not read: ${missing.join(', ')}. ` +
        `Upload a sharper picture or correct the data. Read so far: name="${name}", address="${body.Street} ${body.HouseNumber}, ${body.PostalCode} ${body.City} ${body.Country}"`)
    }
    const r = await this.http({ method: 'POST', url: `${base}/ChangeRequestSet`, data: body, headers: { 'Content-Type': 'application/json' } })
    const d = r.d || r
    return { crNumber: d.CrNumber, crType: d.CrType || crType, crStatus: d.CrStatus || 'Created', target: `S23 MDG (${cfg().destination})` }
  }
}

/** Try the requested CR type (default ZBP1P1); if S23 rejects it, retry with the fallback (BP1P1) */
async function createChangeRequest (form, crType) {
  const impl = mode() === 'remote' ? remote : mock
  const primary = crType || cfg().crType || 'ZBP1P1'
  // SOA: the CR type is chosen by MDG (default flag of business activity BPPI) - no retry
  const fallback = (process.env.S23_CR_METHOD || cfg().crMethod) === 'soa' ? null : (cfg().crTypeFallback || 'BP1P1')
  try {
    return await impl.createChangeRequest(form, primary)
  } catch (e) {
    if (!fallback || fallback === primary) throw e
    LOG.warn(`CR type ${primary} failed (${e.message}) - retrying with ${fallback}`)
    const r = await impl.createChangeRequest(form, fallback)
    return { ...r, fallbackFrom: primary, fallbackReason: e.message }
  }
}

module.exports = {
  mode,
  findCandidates: form => (mode() === 'remote' ? remote : mock).findCandidates(form),
  createChangeRequest,
  LOG
}
