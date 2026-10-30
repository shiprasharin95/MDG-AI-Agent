"! <p>MDG with AI - create a BP change request with prefilled data (S23 / client 120)</p>
"! Called by Gateway service ZMDG_BP_CR_SRV (ZCL_ZMDG_BP_CR_DPC_EXT) and report ZMDG_BP_CR_TEST.
"!
"! Uses the CONVENIENCE API (CL_USMD_CONV_SOM_GOV_API / IF_USMD_CONV_SOM_GOV_API).
"! The Governance API (CL_USMD_GOV_API) cannot be used in S23: BAdI USMD_CREQUEST_INTEGR
"! (impl. /BPRO/CL_MPP_BP_CREQUEST_INTEG, MDG Plug & Play) instantiates the Convenience API
"! and asserts that no Governance API instance exists (ASSERTION_FAILED).
"!
"! Convenience API sequence:
"!   get_instance -> write_crequest( is_crequest_data ) -> enqueue_entity( it_entity_keys )
"!   -> write_entity_data( it_entity_data ) -> save( ) -> read_crequest( ) for the CR number
"! Data references are created via the model: IF_USMD_MODEL_EXT=>CREATE_DATA_REFERENCE.
CLASS zcl_mdg_bp_cr_create DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES:
      BEGIN OF ty_input,
        cr_type      TYPE usmd_crequest_type,
        description  TYPE usmd_txtlg,
        bp_category  TYPE bu_type,          " 1 person, 2 organization
        bu_group     TYPE bu_group,
        name         TYPE string,
        street       TYPE ad_street,
        house_number TYPE ad_hsnm1,
        postal_code  TYPE ad_pstcd1,
        city         TYPE ad_city1,
        country      TYPE land1,
        tax_type     TYPE bptaxtype,
        tax_number   TYPE bptaxnum,
        bp_temp      TYPE bu_partner,     " optional temporary BP key, e.g. '$2'
      END OF ty_input,
      BEGIN OF ty_result,
        cr_number TYPE usmd_crequest,
        cr_type   TYPE usmd_crequest_type,
        cr_status TYPE usmd_crequest_status,
        bp_temp   TYPE bu_partner,
        messages  TYPE usmd_t_message,
      END OF ty_result.

    CONSTANTS:
      c_cr_type_default  TYPE usmd_crequest_type VALUE 'ZBP1P1',
      c_cr_type_fallback TYPE usmd_crequest_type VALUE 'BP1P1'.

    "! Diagnostics of the last CREATE call - read by ZCL_ZMDG_BP_CR_DPC_EXT when it fails
    CLASS-DATA:
      gv_last_step TYPE string,          " step that was running when it failed
      gt_last_msg  TYPE usmd_t_message.  " MDG messages of the last call

    "! Flattens GT_LAST_MSG into one readable line for the OData error
    CLASS-METHODS get_last_error_text RETURNING VALUE(rv_text) TYPE string.

    "! Creates the CR with is_input-cr_type (default ZBP1P1); retries once with BP1P1.
    CLASS-METHODS create
      IMPORTING is_input         TYPE ty_input
      RETURNING VALUE(rs_result) TYPE ty_result
      RAISING   cx_usmd_conv_som_gov_api
                cx_usmd_gov_api.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_nv,
             name  TYPE fieldname,
             value TYPE string,
           END OF ty_nv,
           tt_nv TYPE STANDARD TABLE OF ty_nv WITH EMPTY KEY.

    CONSTANTS c_model TYPE usmd_model VALUE 'BP'.

    CLASS-METHODS create_with_type
      IMPORTING is_input         TYPE ty_input
                iv_cr_type       TYPE usmd_crequest_type
      RETURNING VALUE(rs_result) TYPE ty_result
      RAISING   cx_usmd_conv_som_gov_api
                cx_usmd_gov_api.

    "! Reads the MDG message collector of the Convenience API (dynamic call, so the
    "! class compiles even if the method name differs in this release)
    CLASS-METHODS collect_messages
      IMPORTING io_api TYPE REF TO if_usmd_conv_som_gov_api.

    "! Build a key+attribute table for one entity and write it into the CR
    CLASS-METHODS write_record
      IMPORTING io_api    TYPE REF TO if_usmd_conv_som_gov_api
                io_model  TYPE REF TO if_usmd_model_ext
                iv_entity TYPE usmd_entity
                it_values TYPE tt_nv
      RAISING   cx_usmd_conv_som_gov_api
                cx_usmd_gov_api.
ENDCLASS.



CLASS zcl_mdg_bp_cr_create IMPLEMENTATION.

  METHOD get_last_error_text.
    DATA lv_line TYPE string.
    rv_text = |Step: { gv_last_step }|.
    LOOP AT gt_last_msg INTO DATA(ls_msg) WHERE msgty CA 'EAX'.
      MESSAGE ID ls_msg-msgid TYPE 'S' NUMBER ls_msg-msgno
        WITH ls_msg-msgv1 ls_msg-msgv2 ls_msg-msgv3 ls_msg-msgv4 INTO lv_line.
      rv_text = |{ rv_text }; { ls_msg-msgty }{ ls_msg-msgid }{ ls_msg-msgno }: { lv_line }|.
    ENDLOOP.
    IF strlen( rv_text ) > 220.
      rv_text = rv_text(220).
    ENDIF.
  ENDMETHOD.


  METHOD collect_messages.
    DATA: lt_msg  TYPE usmd_t_message,
          lo_coll TYPE REF TO object.
    " Message collector is not part of IF_USMD_CONV_SOM_GOV_API in every release ->
    " call dynamically so the class always compiles.
    TRY.
        lo_coll ?= io_api.
        CALL METHOD lo_coll->('IF_USMD_CONV_SOM_GOV_API~GET_MESSAGES')
          RECEIVING rt_message = lt_msg.
      CATCH cx_root.
        TRY.
            CALL METHOD lo_coll->('GET_MESSAGES')
              IMPORTING et_message = lt_msg.
          CATCH cx_root ##NO_HANDLER.
        ENDTRY.
    ENDTRY.
    APPEND LINES OF lt_msg TO gt_last_msg.
  ENDMETHOD.


  METHOD create.
    CLEAR: gv_last_step, gt_last_msg.
    DATA(lv_type) = COND usmd_crequest_type( WHEN is_input-cr_type IS INITIAL
                                              THEN c_cr_type_default ELSE is_input-cr_type ).
    " NO retry with c_cr_type_fallback here!
    " CL_USMD_CONV_SOM_GOV_API is a singleton per session: after the first attempt
    " MV_CREQUEST_ID_CREATE is filled and SET_ENVIRONMENT raises an exception
    " ("CR already in buffer"). A second attempt in the same session therefore always
    " fails at set_environment and hides the real error of the first attempt.
    rs_result = create_with_type( is_input = is_input iv_cr_type = lv_type ).
  ENDMETHOD.


  METHOD create_with_type.
    DATA: lo_model    TYPE REF TO if_usmd_model_ext,
          lr_key      TYPE REF TO data,
          ls_cr       TYPE usmd_s_crequest,
          lt_ent_keys TYPE usmd_gov_api_ts_ent_tabl,
          lt_messages TYPE usmd_t_message.
    FIELD-SYMBOLS <lt_key> TYPE ANY TABLE.

    " 0. Model (for data references) + Convenience API instance (one CR per session)
    cl_usmd_model_ext=>get_instance( EXPORTING i_usmd_model = c_model
                                     IMPORTING eo_instance  = lo_model
                                               et_message   = lt_messages ).
    IF lo_model IS NOT BOUND.
      RAISE EXCEPTION TYPE cx_usmd_conv_som_gov_api.
    ENDIF.

    gv_last_step = 'get_instance'.
    DATA(lo_api) = cl_usmd_conv_som_gov_api=>get_instance( iv_model_name = c_model ).

    " 1a. Tell the API to work on a NEW change request of this type -----------
    "     (without this the API has no CR -> CX_USMD_GOV_API with CREQUEST_ID 000000000000)
    "     Signature confirmed in S23: IV_CREQUEST_ID, IV_CREQUEST_TYPE, IV_PROCESS, IV_WI_ID,
    "     IV_CREATE_CREQUEST (ABAP_BOOL), IV_EDITION - all optional.
    "     IV_PROCESS = business activity BPP1 "Create Business Partner" (assigned to ZBP1P1).
    gv_last_step = |set_environment (CR type { iv_cr_type })|.
    lo_api->set_environment( iv_crequest_type  = iv_cr_type
                             iv_process        = 'BPP1'
                             iv_create_crequest = abap_true ).

    " 1b. Change request header (CR type, description) ------------------------
    ls_cr-usmd_creq_type = iv_cr_type.
    ls_cr-usmd_creq_text = is_input-description.
    gv_last_step = 'write_crequest (CR header)'.
    lo_api->write_crequest( is_crequest_data = ls_cr ).

    " 2. New BP with temporary key; final number is drawn on activation -------
    " Unique temporary key per CR. A hard-coded '$1' stays locked by the previous
    " (still open) change request -> ENQUEUE_ENTITY fails for every following call.
    DATA: lv_ts  TYPE timestampl,
          lv_num TYPE n LENGTH 9.
    GET TIME STAMP FIELD lv_ts.
    lv_num = lv_ts MOD 1000000000.
    " Caller can pass the temporary key (OData property BpTemp), e.g. '$2'.
    " The only key proven to work so far is the short form '$1' (CR 1533).
    " MDG only assigns records to the CR for temporary keys it knows. The ST22 dumps
    " (USMDKBPADDRNO with '$2', USMDKBPBP_HEADER with a timestamp key) show that
    " self-invented keys are NOT assigned to the CR. '$1' is the key that worked (CR 1533):
    " temporary keys are numbered per change request, the first new object is '$1'.
    CLEAR lv_num.
    " Short temporary keys '$1', '$2', ... are accepted by MDG for BP_HEADER (the '$2' test
    " passed BP_HEADER; only long timestamp keys were rejected). A key stays locked by every
    " open CR that already uses it (e.g. CR 1533 holds '$1'), so we take the first free one.
    DATA: lv_bp       TYPE bu_partner,
          lr_key_line TYPE REF TO data,
          lv_try      TYPE i.

    " Verified with ZMDG_BP_CR_READ on CR 1558: locking ONLY BP_HEADER and writing AD_POSTAL
    " works - MDG creates BP_ADDR (ADDR_GUID) and the address number itself.
    " Locking/writing ADDRNO ourselves leads to MESSAGE_TYPE_X (I_FIELDNAME = USMDKBPADDRNO).
    lo_model->create_data_reference( EXPORTING i_fieldname = 'BP_HEADER'
                                               i_struct    = if_usmd_model_ext=>gc_struct_key
                                               if_table    = abap_true
                                               i_tabtype   = if_usmd_model_ext=>gc_tabtype_sorted
                                     IMPORTING er_data     = lr_key ).
    ASSIGN lr_key->* TO <lt_key>.
    CREATE DATA lr_key_line LIKE LINE OF <lt_key>.
    ASSIGN lr_key_line->* TO FIELD-SYMBOL(<ls_key>).
    ASSIGN COMPONENT 'BP_HEADER' OF STRUCTURE <ls_key> TO FIELD-SYMBOL(<lv_key>).

    " ---- Address object key (ADDRNO), see CR 1461 object list: BP_HEADER + ADDRNO -----
    " The Convenience API fills the CR object list ONLY in the FIRST enqueue_entity call
    " (SAP comment in IF_USMD_CONV_SOM_GOV_ENTITY~ENQUEUE_ENTITY line 62). A second call for
    " ADDRNO is ignored -> MESSAGE_TYPE_X USMDKBPADDRNO at save. Therefore BOTH objects are
    " locked in ONE call (IT_ENTITY_KEYS is a table of entities).
    " abap_true dumps (MESSAGE_TYPE_X USMDKBPADDRNO, ST22 30.10.2026 05:56) even when
    " BP_HEADER + ADDRNO are locked in ONE call - the Convenience API never puts ADDRNO on
    " the CR object list. Stable setting: abap_false (CR 1564 - saves, data complete in
    " staging, MDG creates BP_ADDR itself; not displayed in the MDG UI).
    CONSTANTS c_full_address TYPE abap_bool VALUE abap_false.
    DATA: lv_addr    TYPE string,
          lr_ak      TYPE REF TO data,
          lr_ak_line TYPE REF TO data.
    FIELD-SYMBOLS: <lt_ak> TYPE ANY TABLE,
                   <ls_ak> TYPE any,
                   <lv_ak> TYPE any.
    IF c_full_address = abap_true.
      lo_model->create_data_reference( EXPORTING i_fieldname = 'ADDRNO'
                                                 i_struct    = if_usmd_model_ext=>gc_struct_key
                                                 if_table    = abap_true
                                                 i_tabtype   = if_usmd_model_ext=>gc_tabtype_sorted
                                       IMPORTING er_data     = lr_ak ).
      ASSIGN lr_ak->* TO <lt_ak>.
      CREATE DATA lr_ak_line LIKE LINE OF <lt_ak>.
      ASSIGN lr_ak_line->* TO <ls_ak>.
      ASSIGN COMPONENT 'ADDRNO' OF STRUCTURE <ls_ak> TO <lv_ak>.   " key of ADDRNO = ADDRNO only (CR 1461)
    ENDIF.

    DO 50 TIMES.
      lv_try = sy-index.
      lv_bp  = COND #( WHEN is_input-bp_temp IS NOT INITIAL THEN is_input-bp_temp
                       ELSE |${ lv_try }| ).
      lv_addr = |${ lv_try }|.              " address temp keys are numbered independently
      CLEAR: <lt_key>, lt_ent_keys.

      <lv_key> = lv_bp.
      INSERT <ls_key> INTO TABLE <lt_key>.
      INSERT VALUE #( entity = 'BP_HEADER' tabl = lr_key ) INTO TABLE lt_ent_keys.

      IF c_full_address = abap_true.
        CLEAR <lt_ak>.
        <lv_ak> = lv_addr.
        INSERT <ls_ak> INTO TABLE <lt_ak>.
        INSERT VALUE #( entity = 'ADDRNO' tabl = lr_ak ) INTO TABLE lt_ent_keys.
      ENDIF.

      gv_last_step = |enqueue_entity BP_HEADER { lv_bp } + ADDRNO { lv_addr } (one call)|.
      TRY.
          lo_api->enqueue_entity( it_entity_keys = lt_ent_keys ).
          EXIT.                                   " keys free -> use them
        CATCH cx_usmd_conv_som_gov_api cx_usmd_gov_api INTO DATA(lx_lock).
          " a key is locked by another (open) CR -> try the next number
          IF is_input-bp_temp IS NOT INITIAL OR lv_try = 50.
            RAISE EXCEPTION lx_lock.
          ENDIF.
      ENDTRY.
    ENDDO.

    " 3. Prefill the data derived by AI from the picture ----------------------
    write_record( io_api = lo_api io_model = lo_model iv_entity = 'BP_HEADER'
                  it_values = VALUE #( ( name = 'BP_HEADER' value = lv_bp )
                                       ( name = 'BU_TYPE'   value = is_input-bp_category )
                                       ( name = 'BU_GROUP'  value = is_input-bu_group ) ) ).

    IF is_input-bp_category = '1'.
      SPLIT is_input-name AT space INTO DATA(lv_first) DATA(lv_last).
      write_record( io_api = lo_api io_model = lo_model iv_entity = 'BP_CENTRL'
                    it_values = VALUE #( ( name = 'BP_HEADER'  value = lv_bp )
                                         " NAME_LAST confirmed (CR 1564). First name attribute in
                                         " S23 model BP not yet confirmed - candidates below,
                                         " unknown names are skipped by write_record.
                                         ( name = 'NAME_FIRST' value = lv_first )
                                         ( name = 'NAME_FIRS'  value = lv_first )
                                         ( name = 'NAMEFIRST'  value = lv_first )
                                         ( name = 'FIRSTNAME'  value = lv_first )
                                         ( name = 'NAME_LAST'  value = lv_last )
                                         ( name = 'MCNAME1'    value = to_upper( lv_last ) ) ) ).
    ELSE.
      write_record( io_api = lo_api io_model = lo_model iv_entity = 'BP_CENTRL'
                    it_values = VALUE #( ( name = 'BP_HEADER' value = lv_bp )
                                         ( name = 'NAME_ORG1' value = is_input-name ) ) ).
    ENDIF.

    " Address - structure copied 1:1 from reference CR 1461 (created in the MDG UI):
    "   object list : BP_HEADER $251 + ADDRNO $180  (both locked above in ONE call)
    "   ADDRNO      : ADDRNO
    "   ADDRESS     : BP_HEADER, ADDRNO, TYPE = 1
    "   BP_ADDR     : BP_HEADER, ADDRNO, VALID_FRM = today, VALID_TO = 31.12.9999
    "   BP_ADUSTD   : BP_HEADER, ADDRNO, BP_ADRKND = XXDEFAULT, ADUS_VDFR/ADUS_VDTO
    "   AD_POSTAL   : BP_HEADER, ADDRNO, STREET, HOUSE_NR1, POST_COD1, CITY1, REF_POSTA, LANGU_COM
    " c_full_address = abap_false -> CR 1564 behaviour (AD_POSTAL only, saves, not shown in UI).
    IF c_full_address = abap_true.
      DATA(lv_today) = |{ sy-datum }|.
      write_record( io_api = lo_api io_model = lo_model iv_entity = 'ADDRNO'
                    it_values = VALUE #( ( name = 'ADDRNO' value = lv_addr ) ) ).
      write_record( io_api = lo_api io_model = lo_model iv_entity = 'ADDRESS'
                    it_values = VALUE #( ( name = 'BP_HEADER' value = lv_bp )
                                         ( name = 'ADDRNO'    value = lv_addr )
                                         ( name = 'TYPE'      value = '1' ) ) ).
      write_record( io_api = lo_api io_model = lo_model iv_entity = 'BP_ADDR'
                    it_values = VALUE #( ( name = 'BP_HEADER' value = lv_bp )
                                         ( name = 'ADDRNO'    value = lv_addr )
                                         ( name = 'VALID_FRM' value = lv_today )
                                         ( name = 'VALID_TO'  value = '99991231' ) ) ).
      write_record( io_api = lo_api io_model = lo_model iv_entity = 'BP_ADUSTD'
                    it_values = VALUE #( ( name = 'BP_HEADER' value = lv_bp )
                                         ( name = 'ADDRNO'    value = lv_addr )
                                         ( name = 'BP_ADRKND' value = 'XXDEFAULT' )
                                         ( name = 'ADUS_VDFR' value = lv_today )
                                         ( name = 'ADUS_VDTO' value = '99991231' ) ) ).
    ENDIF.

    write_record( io_api = lo_api io_model = lo_model iv_entity = 'AD_POSTAL'
                  it_values = VALUE #( ( name = 'BP_HEADER'  value = lv_bp )
                                       ( name = 'ADDRNO'     value = lv_addr )
                                       ( name = 'STREET'     value = is_input-street )
                                       ( name = 'HOUSE_NR1'  value = is_input-house_number )
                                       ( name = 'POST_COD1'  value = is_input-postal_code )
                                       ( name = 'CITY1'      value = is_input-city )
                                       ( name = 'REF_POSTA'  value = is_input-country )
                                       ( name = 'LANGU_COM'  value = sy-langu ) ) ).

    IF is_input-tax_number IS NOT INITIAL.
      write_record( io_api = lo_api io_model = lo_model iv_entity = 'BP_TAXNUM'
                    it_values = VALUE #( ( name = 'BP_HEADER' value = lv_bp )
                                         ( name = 'TAXTYPE'   value = is_input-tax_type )
                                         ( name = 'TAXNUM'    value = is_input-tax_number ) ) ).
    ENDIF.

    " 4. Save entity data into the (now existing) CR ---------------------------
    gv_last_step = 'save (entity data)'.
    lo_api->save( ).
    collect_messages( lo_api ).
    COMMIT WORK AND WAIT.

    " 5. Result (READ_CREQUEST returns RS_CREQUEST_DATA) ----------------------
    TRY.
        ls_cr = lo_api->read_crequest( ).
      CATCH cx_root ##NO_HANDLER.
    ENDTRY.
    rs_result-cr_number = ls_cr-usmd_crequest.
    " NOTE: the Convenience API has no START_WORKFLOW. SAVE on a new CR creates it and
    " triggers the CR workflow (same as "Submit" in the MDG UI). Verify in USMD_SSW /
    " My Change Requests; if it stays in draft, submit it once from the UI.
    rs_result-cr_status = ls_cr-usmd_creq_status.
    rs_result-cr_type   = iv_cr_type.
    rs_result-bp_temp   = lv_bp.
  ENDMETHOD.


  METHOD write_record.
    DATA: lr_tab TYPE REF TO data,
          lt_ent TYPE usmd_gov_api_ts_ent_data.
    FIELD-SYMBOLS <lt_data> TYPE ANY TABLE.

    " BUFFER_UNSAVED_CHANGE (called inside WRITE_ENTITY_DATA) types IT_ENTITY_DATA as
    " INDEX TABLE -> the default (hashed) table is rejected (CX_SY_DYN_CALL_ILLEGAL_TYPE).
    " A SORTED table is an index table and is accepted.
    io_model->create_data_reference( EXPORTING i_fieldname = CONV fieldname( iv_entity )
                                               i_struct    = if_usmd_model_ext=>gc_struct_key_attr
                                               if_table    = abap_true
                                               i_tabtype   = if_usmd_model_ext=>gc_tabtype_sorted
                                     IMPORTING er_data     = lr_tab ).
    ASSIGN lr_tab->* TO <lt_data>.
    DATA lr_line TYPE REF TO data.
    CREATE DATA lr_line LIKE LINE OF <lt_data>.
    ASSIGN lr_line->* TO FIELD-SYMBOL(<ls_data>).

    LOOP AT it_values INTO DATA(ls_nv) WHERE value IS NOT INITIAL.
      ASSIGN COMPONENT ls_nv-name OF STRUCTURE <ls_data> TO FIELD-SYMBOL(<lv>).
      IF sy-subrc = 0.
        <lv> = ls_nv-value.
      ENDIF.
    ENDLOOP.
    INSERT <ls_data> INTO TABLE <lt_data>.

    INSERT VALUE #( entity = iv_entity entity_data = lr_tab ) INTO TABLE lt_ent.
    gv_last_step = |write_entity_data { iv_entity }|.
    io_api->write_entity_data( it_entity_data = lt_ent ).
    collect_messages( io_api ).
  ENDMETHOD.

ENDCLASS.
