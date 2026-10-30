using mdgai from '../db/schema';
using s23 from '../db/s23-mock';

@path    : '/odata/v4/mdg-ai'
@(requires: 'User')  // role template MdgAiUser -> scope $XSAPPNAME.User (role collection MDG_AI_BP_User)
service MdgAiService {

  @cds.redirection.target
  entity FormUploads         as projection on mdgai.FormUploads excluding { content, preview }
    actions {
      /** Re-run AI extraction on the stored file */
      @(Common.SideEffects: {TargetEntities: ['in', 'in/matches', 'in/log']})
      action extract()        returns FormUploads;
      /** Duplicate check against S23 (BUT000 / ADRC / DFKKBPTAXNUM) */
      @(Common.SideEffects: {TargetEntities: ['in', 'in/matches', 'in/log']})
      action checkDuplicate() returns FormUploads;
      /** Auto. creation of CR with prefilled data in MDG */
      @(Common.SideEffects: {TargetEntities: ['in', 'in/log']})
      action createChangeRequest(
        @(title: 'Change Request Type') crType : String(12)
      )                       returns FormUploads;
      /** Run the full flow again: extract -> duplicate check -> create CR */
      @(Common.SideEffects: {TargetEntities: ['in', 'in/matches', 'in/log']})
      action reprocess()      returns FormUploads;
    };

  @readonly entity DuplicateCandidates as projection on mdgai.DuplicateCandidates;
  @readonly entity ProcessingLog       as projection on mdgai.ProcessingLog;
  @readonly entity ProcessStatuses     as projection on mdgai.ProcessStatuses;

  /** Upload an image / PDF (base64) and run the complete process */
  action uploadForm(
    fileName : String,
    mimeType : String,
    content  : LargeString // base64
  ) returns FormUploads;

  /** Read-only view of the S23 master data (mock or remote) for the demo */
  @readonly entity BusinessPartners as projection on s23.BUT000;
  @readonly entity Addresses        as projection on s23.ADRC;
  @readonly entity TaxNumbers       as projection on s23.DFKKBPTAXNUM;
  @readonly entity ChangeRequests   as projection on s23.MDG_CR;

  /** E-mail channel: read new mails from the inbox now and process their attachments */
  action pollMailbox() returns {
    mails       : Integer;
    attachments : Integer;
    skipped     : LargeString;
  };

  function config() returns {
    s23Mode    : String;
    destination: String;
    crType     : String;
    aiProvider : String;
  };
}
