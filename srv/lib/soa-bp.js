/**
 * Option 3 - Standard SAP SOA inbound service BusinessPartnerSUITEBulkReplicateRequest_In.
 *
 * MDG creates the change request itself (DRF inbound setting "create change request"):
 *   - new BP      -> business activity BPPI (logical action CREATE_DX)
 *   - existing BP -> business activity BPPU (CHANGE_DX)
 *   - CR type     -> the CR type with the "Default" flag for that business activity
 *                    (set ZBP1P1 as default for BPPI in MDGIMG)
 * No custom ABAP, no temporary keys, MDG handles address/key assignment itself.
 *
 * The service is ASYNCHRONOUS: S23 answers HTTP 202 and creates the CR in the background
 * (SXMB_MONI / SRT_MONI). The CR number is therefore not returned in the response; the app
 * stores the MessageID and the CR can be looked up later in USMD120C / My Change Requests.
 *
 * !! The SOAP payload below follows the SAP ESR structure of
 *    BusinessPartnerSUITEBulkReplicateRequest (namespace http://sap.com/xi/SAPGlobal20/Global).
 *    It is NOT yet tested against S23 - compare it with the WSDL from SOAMANAGER
 *    (Open Binding WSDL) and adjust element names if the S23 release differs.
 */
const cds = require('@sap/cds')
const LOG = cds.log('mdgai-soa')

const xml = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const uuid = () => cds.utils.uuid()
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Builds the SOAP envelope for one new business partner */
function buildEnvelope (form, { senderBusinessSystem = 'MDG_AI_CAP' } = {}) {
  const isPerson = form.bpCategory === '1'
  const [first, ...rest] = (form.name || '').trim().split(/\s+/)
  const last = rest.join(' ')
  const msgId = uuid()
  const bpUuid = uuid()

  const common = isPerson
    ? `<Person>
            <Name>
              <GivenName>${xml(first)}</GivenName>
              <FamilyName>${xml(last)}</FamilyName>
            </Name>
          </Person>`
    : `<Organisation>
            <Name>
              <FirstLineName>${xml((form.name || '').slice(0, 40))}</FirstLineName>
              <SecondLineName>${xml((form.name || '').slice(40, 80))}</SecondLineName>
            </Name>
          </Organisation>`

  const tax = form.taxNumber
    ? `<TaxNumber actionCode="01">
          <PartyTaxID>${xml(form.taxNumber)}</PartyTaxID>
          <TaxIdentificationNumberTypeCode>${xml(form.taxType || 'DE0')}</TaxIdentificationNumberTypeCode>
        </TaxNumber>`
    : ''

  // Namespace confirmed by S23 SRT error log: INTERFACE_NAMESPACE http://sap.com/xi/SAP_BS_FND/MDG/Global2
  // Asynchronous service with reliable messaging -> a Message ID is mandatory for plain SOAP
  // ("SRT: Plain SOAP: Reliable messaging (RM) configured, but no Message ID ...").
  // Interface namespace (SRT log) is .../SAP_BS_FND/MDG/Global2, but the MESSAGE element lives in
  // the global data type namespace. S23 rejected the element in MDG/Global2 ("Message ... not
  // supported"), so the default is SAPGlobal20/Global. Override: cf set-env ... S23_SOA_NS <ns>
  const ns = process.env.S23_SOA_NS || 'http://sap.com/xi/SAPGlobal20/Global'
  const envelope = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:glob="${ns}"
                  xmlns:wsa="http://www.w3.org/2005/08/addressing">
  <soapenv:Header>
    <wsa:MessageID>urn:uuid:${msgId}</wsa:MessageID>
    <wsa:Action>http://sap.com/xi/SAP_BS_FND/MDG/Global2/BusinessPartnerSUITEBulkReplicateRequest_In/BusinessPartnerSUITEBulkReplicateRequest_InRequest</wsa:Action>
  </soapenv:Header>
  <soapenv:Body>
    <glob:BusinessPartnerSUITEBulkReplicateRequest>
      <MessageHeader>
        <UUID>${msgId}</UUID>
        <CreationDateTime>${nowIso()}</CreationDateTime>
        <SenderBusinessSystemID>${xml(senderBusinessSystem)}</SenderBusinessSystemID>
      </MessageHeader>
      <BusinessPartnerSUITEReplicateRequestMessage>
        <MessageHeader>
          <UUID>${uuid()}</UUID>
          <CreationDateTime>${nowIso()}</CreationDateTime>
          <SenderBusinessSystemID>${xml(senderBusinessSystem)}</SenderBusinessSystemID>
        </MessageHeader>
        <BusinessPartner actionCode="01">
          <UUID>${bpUuid}</UUID>
          <CategoryCode>${isPerson ? '1' : '2'}</CategoryCode>
          <Common actionCode="01">
          ${common}
          </Common>
          <AddressInformation actionCode="01">
            <UUID>${uuid()}</UUID>
            <AddressUsage actionCode="01">
              <AddressUsageCode>XXDEFAULT</AddressUsageCode>
            </AddressUsage>
            <Address>
              <PostalAddress>
                <CountryCode>${xml(form.country)}</CountryCode>
                <CityName>${xml(form.city)}</CityName>
                <StreetPostalCode>${xml(form.postalCode)}</StreetPostalCode>
                <StreetName>${xml(form.street)}</StreetName>
                <HouseID>${xml(form.houseNumber)}</HouseID>
              </PostalAddress>
            </Address>
          </AddressInformation>
          ${tax}
        </BusinessPartner>
      </BusinessPartnerSUITEReplicateRequestMessage>
    </glob:BusinessPartnerSUITEBulkReplicateRequest>
  </soapenv:Body>
</soapenv:Envelope>`
  return { envelope, msgId, bpUuid }
}

/**
 * Sends the SOAP request through the same BTP destination as the OData calls.
 * @param http  function(opts) of srv/lib/s23.js (handles destination, JWT, CSRF, errors)
 */
async function createViaSoa (form, http, cfg) {
  const path = cfg.soaServicePath
  if (!path) {
    throw new Error('SOA endpoint not configured: set cds.mdgai.s23.soaServicePath to the ' +
      'SOAMANAGER binding path of BusinessPartnerSUITEBulkReplicateRequest_In')
  }
  const { envelope, msgId, bpUuid } = buildEnvelope(form, { senderBusinessSystem: cfg.soaSenderSystem })
  LOG.info(`SOA BusinessPartnerSUITEBulkReplicateRequest_In -> ${path}, MessageID ${msgId}`)
  await http({
    method: 'POST',
    url: path,
    // SAP plain SOAP also accepts the message ID as URL parameter (32 hex chars, no dashes)
    params: { MessageId: msgId.replace(/-/g, '').toUpperCase() },
    data: envelope,
    soap: true,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: '"http://sap.com/xi/WebService/soap1.1"',
      Accept: 'text/xml'
    }
  })
  return {
    crNumber: '',   // asynchronous - MDG creates the CR in the background
    crType: cfg.crType || 'BPPI-dflt',   // DB column is String(12)
    crStatus: 'Submitted to MDG (async)',
    messageId: msgId,
    bpUuid,
    target: `S23 MDG via SOA BusinessPartnerSUITEBulkReplicateRequest_In (MessageID ${msgId})`
  }
}

module.exports = { buildEnvelope, createViaSoa }
