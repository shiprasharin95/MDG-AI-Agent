const cds = require('@sap/cds')

async function toBuffer (v) {
  if (!v) return null
  if (Buffer.isBuffer(v)) return v
  if (typeof v === 'string') return Buffer.from(v, 'base64')
  if (typeof v.pipe === 'function' || v[Symbol.asyncIterator]) {
    const chunks = []; for await (const c of v) chunks.push(Buffer.from(c)); return Buffer.concat(chunks)
  }
  return Buffer.from(v)
}

// Serve uploaded files / rendered previews: GET /files/<ID>/preview | /files/<ID>/original
cds.on('bootstrap', app => {
  // Protect the file route with the same XSUAA check as the OData service (production only)
  if (cds.env.requires.auth?.kind === 'xsuaa') {
    const xssec = require('@sap/xssec')
    const authService = new xssec.XsuaaService(cds.env.requires.auth.credentials)
    app.use('/files', async (req, res, next) => {
      try {
        const sc = await xssec.createSecurityContext(authService, { req })
        if (sc.checkLocalScope('User')) return next()
        res.status(403).send('Forbidden - role collection MDG_AI_BP_User required')
      } catch (e) {
        res.status(401).send('Unauthorized')
      }
    })
  }

  app.get('/files/:id/:kind(preview|original)', async (req, res) => {
    try {
      const { FormUploads } = cds.entities('mdgai')
      // LargeBinary columns come back as streams on HANA -> consume them inside the transaction
      const out = await cds.tx(async () => {
        const row = await SELECT.one.from(FormUploads, req.params.id).columns('preview', 'content', 'mimeType', 'fileName')
        if (!row) return null
        const wantPreview = req.params.kind === 'preview'
        const preview = wantPreview ? await toBuffer(row.preview) : null
        const data = preview || await toBuffer(row.content)
        return { data, mime: preview ? 'image/png' : row.mimeType, fileName: row.fileName, isPreview: !!preview }
      })
      if (!out || !out.data) return res.status(404).send('Not found')
      res.set('Content-Type', out.mime)
      if (!out.isPreview) res.set('Content-Disposition', `inline; filename="${encodeURIComponent(out.fileName)}"`)
      res.send(out.data)
    } catch (e) {
      cds.log('files').error(e)
      res.status(500).send(e.message)
    }
  })
})

module.exports = cds.server
