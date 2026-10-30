using MdgAiService as srv from '../../srv/mdg-ai-service';

annotate srv.FormUploads with @(
  UI.HeaderInfo: {
    TypeName      : 'Customer Form Upload',
    TypeNamePlural: 'Customer Form Uploads',
    Title         : { Value: name },
    Description   : { Value: fileName },
    ImageUrl      : previewUrl
  },

  UI.SelectionFields: [ status_code, name, taxNumber, matchedPartner, crNumber, createdAt ],

  UI.LineItem: [
    { Value: seqNo,            Label: 'No.' },
    { Value: fileName,         Label: 'File' },
    { Value: source,           Label: 'Source' },
    { Value: name,             Label: 'Name' },
    { Value: street,           Label: 'Street' },
    { Value: houseNumber,      Label: 'No.' },
    { Value: postalCode,       Label: 'Postal Code' },
    { Value: city,             Label: 'City' },
    { Value: country,          Label: 'Country' },
    { Value: taxNumber,        Label: 'Tax Number' },
    { Value: status_code,      Label: 'Status', Criticality: statusCriticality, CriticalityRepresentation: #WithIcon },
    { Value: matchedPartner,   Label: 'Existing BP' },
    { $Type: 'UI.DataFieldWithUrl', Value: crNumber, Url: crLink, Label: 'MDG CR' },
    { Value: createdAt,        Label: 'Uploaded At' },
    { $Type: 'UI.DataFieldForAction', Action: 'MdgAiService.reprocess', Label: 'Reprocess' }
  ],

  UI.PresentationVariant: {
    SortOrder     : [{ Property: seqNo, Descending: true }],
    Visualizations: ['@UI.LineItem']
  },

  UI.HeaderFacets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#status' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#bp' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#cr' }
  ],
  UI.DataPoint#status: { Value: status_code, Title: 'Process Status', Criticality: statusCriticality },
  UI.DataPoint#bp    : { Value: matchedPartner, Title: 'Existing Business Partner' },
  UI.DataPoint#cr    : { Value: crNumber, Title: 'MDG Change Request' },

  UI.Identification: [
    { $Type: 'UI.DataFieldForAction', Action: 'MdgAiService.checkDuplicate',      Label: 'Run Duplicate Check' },
    { $Type: 'UI.DataFieldForAction', Action: 'MdgAiService.createChangeRequest', Label: 'Create MDG Change Request' },
    { $Type: 'UI.DataFieldForAction', Action: 'MdgAiService.extract',             Label: 'Re-run AI Extraction' }
  ],

  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'Result',     Label: 'Result',                     Target: '@UI.FieldGroup#Result' },
    { $Type: 'UI.CollectionFacet', ID: 'Extracted', Label: 'Data Extracted by AI', Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Business Partner', Target: '@UI.FieldGroup#Name' },
      { $Type: 'UI.ReferenceFacet', Label: 'Address',          Target: '@UI.FieldGroup#Address' },
      { $Type: 'UI.ReferenceFacet', Label: 'Tax',              Target: '@UI.FieldGroup#Tax' },
      { $Type: 'UI.ReferenceFacet', Label: 'Extraction',       Target: '@UI.FieldGroup#Extraction' }
    ]},
    { $Type: 'UI.ReferenceFacet', ID: 'Matches',  Label: 'Duplicate Check (BUT000 / ADRC / DFKKBPTAXNUM)', Target: 'matches/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', ID: 'CR',       Label: 'MDG Change Request', Target: '@UI.FieldGroup#CR' },
    { $Type: 'UI.ReferenceFacet', ID: 'Log',      Label: 'Process Log',        Target: 'log/@UI.LineItem' }
  ],

  UI.FieldGroup#Result: { Data: [
    { Value: status_code, Label: 'Status', Criticality: statusCriticality },
    { Value: message,     Label: 'Message' },
    { Value: source,      Label: 'Source' },
    { Value: mailFrom,    Label: 'E-mail from' },
    { Value: mailSubject, Label: 'E-mail subject' },
    { Value: replyStatus, Label: 'Reply to sender' }
  ]},
  UI.FieldGroup#Name: { Data: [
    { Value: name,       Label: 'Name' },
    { Value: bpCategory, Label: 'BP Category' }
  ]},
  UI.FieldGroup#Address: { Data: [
    { Value: street,      Label: 'Street' },
    { Value: houseNumber, Label: 'House Number' },
    { Value: postalCode,  Label: 'Postal Code' },
    { Value: city,        Label: 'City' },
    { Value: country,     Label: 'Country' }
  ]},
  UI.FieldGroup#Tax: { Data: [
    { Value: taxNumber, Label: 'Tax Number' },
    { Value: taxType,   Label: 'Tax Category' }
  ]},
  UI.FieldGroup#Extraction: { Data: [
    { Value: extractionMethod, Label: 'Method' },
    { Value: extractionNote,   Label: 'Note' },
    { Value: rawText,          Label: 'Recognised Text' },
    { $Type: 'UI.DataFieldWithUrl', Value: fileName, Url: previewUrl, Label: 'Uploaded Document' }
  ]},
  UI.FieldGroup#CR: { Data: [
    { $Type: 'UI.DataFieldWithUrl', Value: crNumber, Url: crLink, Label: 'Change Request (open in S23)' },
    { Value: crType,      Label: 'CR Type' },
    { Value: crStatus,    Label: 'CR Status' },
    { Value: crCreatedAt, Label: 'Created At' },
    { Value: matchReason, Label: 'Duplicate Rule' },
    { Value: checkedAt,   Label: 'Checked At' }
  ]}
);

annotate srv.FormUploads with {
  status         @title: 'Status' @Common: { Text: status.name, TextArrangement: #TextOnly, ValueListWithFixedValues,
                    ValueList: { CollectionPath: 'ProcessStatuses', Parameters: [
                      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: status_code, ValueListProperty: 'code' },
                      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' } ] } };
  name           @title: 'Name';
  taxNumber      @title: 'Tax Number';
  matchedPartner @title: 'Existing BP';
  crNumber       @title: 'MDG CR';
  createdAt      @title: 'Uploaded At';
  message        @UI.MultiLineText;
  rawText        @UI.MultiLineText;
  bpCategory     @title: 'BP Category';
  previewUrl     @UI.Hidden;
  statusCriticality @UI.Hidden;
  ID             @UI.Hidden;
};

annotate srv.FormUploads actions {
  createChangeRequest @(
    Core.OperationAvailable: { $edmJson: { $And: [
      { $Eq: [ { $Path: 'in/duplicateFound' }, false ] },
      { $Eq: [ { $Path: 'in/crNumber' }, null ] }
    ]}}
  ) (crType @(title: 'Change Request Type', UI.ParameterDefaultValue: 'ZBP1P1'));
  checkDuplicate @(Core.OperationAvailable: { $edmJson: { $Eq: [ { $Path: 'in/crNumber' }, null ] } });
};

annotate srv.DuplicateCandidates with @(
  UI.LineItem: [
    { Value: partner,      Label: 'BP (BUT000)' },
    { Value: partnerName,  Label: 'Name (BUT000)' },
    { Value: address,      Label: 'Address (ADRC)' },
    { Value: taxNumber,    Label: 'Tax (DFKKBPTAXNUM)' },
    { Value: nameMatch,    Label: 'Name Match' },
    { Value: addressMatch, Label: 'Address Match' },
    { Value: taxMatch,     Label: 'Tax Match' },
    { Value: isDuplicate,  Label: 'Duplicate', Criticality: criticality },
    { Value: rule,         Label: 'Rule' }
  ]
);

annotate srv.ProcessingLog with @(
  UI.PresentationVariant: { SortOrder: [{ Property: seq }], Visualizations: ['@UI.LineItem'] },
  UI.LineItem: [
    { Value: seq,       Label: '#' },
    { Value: step,      Label: 'Step' },
    { Value: result,    Label: 'Result', Criticality: criticality },
    { Value: details,   Label: 'Details' },
    { Value: timestamp, Label: 'Time' }
  ]
);
