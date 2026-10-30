namespace mdgai;

using {
  cuid,
  managed,
  sap.common.CodeList
} from '@sap/cds/common';

/**
 * Processing status of an uploaded customer form
 *  UPLOADED   -> file stored, waiting for AI extraction
 *  EXTRACTED  -> AI extracted Name / Address / Tax
 *  DUPLICATE  -> BP already exists in S23 (Notification for existing duplicate)
 *  NO_MATCH   -> no BP found, CR not (yet) created
 *  CR_CREATED -> MDG change request created with prefilled data
 *  ERROR      -> technical error in one of the steps
 */
type ProcessStatus : String(12) enum {
  UPLOADED;
  EXTRACTED;
  DUPLICATE;
  NO_MATCH;
  CR_CREATED;
  ERROR;
}

entity ProcessStatuses : CodeList {
  key code        : ProcessStatus;
      criticality : Integer;
}

/** One uploaded picture / PDF of a filled-out customer form */
entity FormUploads : cuid, managed {
  // --- Step 1: Upload picture in SAP CAP --------------------------------
  fileName          : String(255);
  mimeType          : String(100);
  @Core.MediaType  : mimeType
  @Core.ContentDisposition.Filename: fileName
  content           : LargeBinary;
  /** PNG rendering of the uploaded document (used for preview + AI vision) */
  @Core.MediaType  : 'image/png'
  preview           : LargeBinary;
  previewUrl        : String(255);

  /** Running number 1, 2, 3, ... (assigned on creation) */
  seqNo             : Integer;

  // --- Source: UI upload or e-mail --------------------------------------
  source            : String(10) default 'UI';   // UI | EMAIL
  mailMessageId     : String(500);                // Graph internetMessageId (de-duplication)
  mailFrom          : String(320);
  mailSubject       : String(255);
  mailReceivedAt    : Timestamp;
  replySentAt       : Timestamp;
  replyStatus       : String(255);

  // --- Step 2a: AI extraction ------------------------------------------
  extractionMethod  : String(40);
  extractionNote    : String(500);
  rawText           : LargeString;
  bpCategory        : String(1) default '2'; // 1 = Person, 2 = Organization
  name              : String(160);
  street            : String(60);
  houseNumber       : String(10);
  postalCode        : String(10);
  city              : String(40);
  country           : String(3);
  taxType           : String(4);
  taxNumber         : String(20);

  // --- Step 2b: Duplicate check (BUT000 / ADRC / DFKKBPTAXNUM) --------
  status            : Association to ProcessStatuses default 'UPLOADED';
  statusCriticality : Integer default 0;
  duplicateFound    : Boolean default false;
  matchedPartner    : String(10);
  matchReason       : String(255);
  checkedAt         : Timestamp;

  // --- Step 3: Auto. creation of CR with prefilled data in MDG --------
  crNumber          : String(12);
  crType            : String(12);
  crStatus          : String(40);
  crCreatedAt       : Timestamp;
  /** Direct link to the CR in S23 MDG (Web Dynpro) */
  crLink            : String(500);

  message           : String(1000);

  matches           : Composition of many DuplicateCandidates
                        on matches.upload = $self;
  log               : Composition of many ProcessingLog
                        on log.upload = $self;
}

/** BP candidates found in S23 during the duplicate check */
entity DuplicateCandidates : cuid {
  upload        : Association to FormUploads;
  partner       : String(10);
  partnerName   : String(160);
  address       : String(255);
  taxNumber     : String(20);
  nameMatch     : Boolean;
  addressMatch  : Boolean;
  taxMatch      : Boolean;
  isDuplicate   : Boolean;
  rule          : String(80);
  criticality   : Integer;
}

/** Step protocol, one line per process step */
entity ProcessingLog : cuid {
  upload      : Association to FormUploads;
  seq         : Integer;
  step        : String(60);
  result      : String(20);
  details     : String(1000);
  criticality : Integer;
  timestamp   : Timestamp;
}
