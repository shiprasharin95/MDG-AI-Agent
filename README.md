# MDG AI Agent – Business Partner from Picture / E-mail

SAP CAP + Fiori elements app on SAP BTP that turns a scanned customer form into an
SAP MDG change request:

1. **Input** – upload a PDF/image in the app, **or** e-mail it to `cap-notifications@bearingpoint.com`
   with a subject containing **"AI MDG Agent"**.
2. **AI extraction** – SAP AI Core (gpt-4o) reads name, address and tax number
   (fallback: PDF text layer / local OCR).
3. **Duplicate check in S23** (client 120) via `API_BUSINESS_PARTNER`
   – duplicate = (name **and** address identical) **or** tax number identical (BUT000 / ADRC / DFKKBPTAXNUM).
4. **MDG change request** – if no duplicate: CR type `ZBP1P1` via OData service in S23.
5. **Result mail** – automatically from `cap-notifications@bearingpoint.com`
   (duplicate BP number or CR number, with links to the app and to the CR in S23 MDG).

## Architecture

```
User ──upload──► Approuter (XSUAA) ──► CAP srv (Node.js) ──► HANA Cloud (HDI)
User ──e-mail──► cap-notifications@ ◄─ Graph poll (2 min) ─┤
                                                           ├──► SAP AI Core (gpt-4o)
                                                           ├──► S23 via Cloud Connector
                                                           │      API_BUSINESS_PARTNER  (duplicate check)
                                                           │      ZMDG_BP_CR_TEST_SRV   (create CR)
                                                           └──► Microsoft Graph (result mail)
```

## BTP (subaccount *SAP GenAI [Restricted Access]*, space *GenAI*)

| Object | Name |
|---|---|
| Apps | `mdg-ai-bp` (approuter), `mdg-ai-bp-srv` (CAP), `mdg-ai-bp-db-deployer` |
| Services | `mdg-ai-bp-auth` (xsuaa), `mdg-ai-bp-db` (hdi-shared), `mdg-ai-bp-destination`, `mdg-ai-bp-connectivity`, `AICore` |
| Destinations | `S23_120_BASIC` (BasicAuth) / `S23_client_120` (PrincipalPropagation), `AzureMailService` (Graph) |
| Role collection | `MDG_AI_BP_User` |

## Configuration (env of `mdg-ai-bp-srv`, see `manifest.yml`)

| Variable | Purpose |
|---|---|
| `S23_MODE` | `remote` = real S23, `mock` = local test tables |
| `S23_DESTINATION` | BTP destination to S23 (default `S23_120_BASIC`) |
| `S23_CR_METHOD` | `odata` (custom service) or `soa` (standard `BusinessPartnerSUITEBulkReplicateRequest_In`) |
| `S23_CR_SERVICE` | OData service for CR creation (`/sap/opu/odata/sap/ZMDG_BP_CR_TEST_SRV`) |
| `MAIL_INBOX` / `MAIL_SUBJECT_KEYWORD` | mailbox read + subject keyword (`ai mdg agent`) |
| `MAIL_NOTIFY_TO` / `MAIL_REPLY_TO` | recipient of result mails for UI uploads / override for tests |
| `S23_NWBC_URL` / `S23_CR_LINK` | links into S23 MDG in the result mail (`{CR}` placeholder) |

Switch at runtime without redeploy: `cf set-env mdg-ai-bp-srv <VAR> <value>` + `cf restart mdg-ai-bp-srv`.

## Run / test locally

```bash
npm install
npm test              # 12 tests: sample forms, mail channel (mocked Graph), SOAP envelope
npx cds watch         # mock mode, http://localhost:4004
```

## Deploy (Windows, without mbt)

```bash
npm run build                                   # cds build + copy UI into gen/srv
cf push -f deploy/db-manifest.yml               # HANA schema (stop the app afterwards)
cf push -f gen/srv/manifest-srv.yml -p gen/srv  # CAP backend (manifest generated from manifest.yml)
cf push -f app/router/manifest.yml -p app/router
```

## S23 / ABAP (`abap/`)

| Object | Purpose |
|---|---|
| `ZCL_MDG_BP_CR_CREATE` | creates BP CR via MDG Convenience API (`ZMDG_BP_CR_SRV`) |
| `ZCL_ZMDG_BP_CR_DPC_EXT` | Gateway DPC for `ChangeRequestSet` |
| `ZMDG_BP_CR_READ` | diagnostic report – dumps all entity data of a CR (compare with UI-created CRs) |
| `ZMDG_BP_CR_TEST` | test report for the class |

The app currently uses the colleague's tested service `ZMDG_BP_CR_TEST_SRV` (class `ZCL_MDG_BP_TEST_CR_CREATE`).

## Open points

- **Graph `Mail.Read`** on `cap-notifications@bearingpoint.com` for the app behind `AzureMailService`
  (sending already works; reading returns 403 until granted).
- **SLD business system `S23CLNT120`** – needed for the standard SOAP route (`S23_CR_METHOD=soa`).
- Duplicate check covers only **active** BPs, not BPs in open CRs.
- Links to S23 work only inside the BearingPoint network / VPN.

## Samples

`samples/` – the four test forms from the use case and the use-case description.
