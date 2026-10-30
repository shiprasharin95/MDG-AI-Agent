/**
 * Local mirror of the S23 (client 120) tables used by the duplicate check.
 * Only used in mode = 'mock'. Field names follow the SAP DDIC names so the
 * same matching logic applies to the real system.
 */
namespace s23;

/** BUT000 - BP: General data I */
entity BUT000 {
  key PARTNER      : String(10);
      TYPE         : String(1);   // 1 Person, 2 Organization
      BU_GROUP     : String(4);
      NAME_ORG1    : String(40);
      NAME_ORG2    : String(40);
      NAME_FIRST   : String(40);
      NAME_LAST    : String(40);
      ADDRNUMBER   : String(10);  // shortcut to the standard address (BUT020)
}

/** ADRC - Addresses (Business Address Services) */
entity ADRC {
  key ADDRNUMBER   : String(10);
      NAME1        : String(40);
      STREET       : String(60);
      HOUSE_NUM1   : String(10);
      POST_CODE1   : String(10);
      CITY1        : String(40);
      COUNTRY      : String(3);
}

/** Simulated MDG change requests (USMD120C header + BP staging payload) */
entity MDG_CR {
  key USMD_CREQUEST : String(12);
      USMD_CREQ_TYPE: String(12);
      USMD_CREQ_TEXT: String(60);
      USMD_CREQ_STATUS : String(2);   // 01 = Changes to be executed
      BP_TEMP_ID    : String(10);     // temporary BP number (staging, e.g. $1)
      NAME_ORG1     : String(40);
      NAME_FIRST    : String(40);
      NAME_LAST     : String(40);
      STREET        : String(60);
      HOUSE_NUM1    : String(10);
      POST_CODE1    : String(10);
      CITY1         : String(40);
      COUNTRY       : String(3);
      TAXTYPE       : String(4);
      TAXNUM        : String(20);
      CREATED_AT    : Timestamp;
}

/** DFKKBPTAXNUM - Tax numbers for business partner */
entity DFKKBPTAXNUM {
  key PARTNER      : String(10);
  key TAXTYPE      : String(4);
      TAXNUM       : String(20);
      TAXNUMXL     : String(60);
}
