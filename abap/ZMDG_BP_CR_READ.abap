*&---------------------------------------------------------------------*
*& Report ZMDG_BP_CR_READ
*& Dumps EVERYTHING stored in an MDG BP change request (all entities,
*& key fields and values) - no keys need to be known.
*&
*& Uses CL_USMD_GOV_API->GET_CREQUEST_DATA (signature taken from SAP's own
*& unit test ltc_usmd_gov_api_t1->check_get_crequest_data_pcr).
*&
*& Run it for:
*&   - CR 1468 (created in the MDG UI, WITH address)  -> shows the correct pattern
*&   - our CR (e.g. 1558)                             -> shows what we wrote
*&---------------------------------------------------------------------*
REPORT zmdg_bp_cr_read.

PARAMETERS p_cr TYPE usmd_crequest OBLIGATORY DEFAULT '1468'.

START-OF-SELECTION.
  DATA: lt_data   TYPE usmd_ts_entity_data_all,
        lt_objl   TYPE usmd_gov_api_t_ent_struc,
        lo_struct TYPE REF TO cl_abap_structdescr.
  FIELD-SYMBOLS: <lt_tab> TYPE ANY TABLE,
                 <ls_row> TYPE any,
                 <lv>     TYPE any,
                 <ls_key> TYPE any.

  DATA(lv_cr) = CONV usmd_crequest( |{ p_cr ALPHA = IN }| ).

  TRY.
      DATA(lo_api) = cl_usmd_gov_api=>get_instance( iv_model_name = 'BP' ).

      " ---- 1. Object list (= USMD1213) with full key structures --------------
      lo_api->get_object_list( EXPORTING iv_crequest_id = lv_cr
                               IMPORTING et_object_list = lt_objl ).
      WRITE: / 'Change request', lv_cr, '- OBJECT LIST' COLOR COL_HEADING.
      LOOP AT lt_objl INTO DATA(ls_obj).
        WRITE: / ls_obj-entity COLOR COL_KEY.
        ASSIGN ls_obj-r_struc->* TO <ls_key>.
        lo_struct ?= cl_abap_typedescr=>describe_by_data( <ls_key> ).
        LOOP AT lo_struct->components INTO DATA(ls_c).
          ASSIGN COMPONENT ls_c-name OF STRUCTURE <ls_key> TO <lv>.
          WRITE: /5 ls_c-name, '=', <lv>.
        ENDLOOP.
      ENDLOOP.
      ULINE.

      " ---- 2. All entity data of the CR ---------------------------------------
      lo_api->get_crequest_data( EXPORTING iv_crequest_id          = lv_cr
                                 IMPORTING et_entity_data_inactive = lt_data ).
    CATCH cx_root INTO DATA(lx).
      WRITE: / 'Error:', lx->get_text( ).
      RETURN.
  ENDTRY.

  WRITE: / 'ENTITY DATA' COLOR COL_HEADING.
  LOOP AT lt_data ASSIGNING FIELD-SYMBOL(<ls_ent>).
    ASSIGN <ls_ent>-r_data->* TO <lt_tab>.
    CHECK <lt_tab> IS ASSIGNED.
    WRITE: / <ls_ent>-usmd_entity COLOR COL_KEY,
             'cont:', <ls_ent>-usmd_entity_cont,
             'struct:', <ls_ent>-struct,
             'rows:', lines( <lt_tab> ).
    LOOP AT <lt_tab> ASSIGNING <ls_row>.
      lo_struct ?= cl_abap_typedescr=>describe_by_data( <ls_row> ).
      LOOP AT lo_struct->components INTO ls_c.
        ASSIGN COMPONENT ls_c-name OF STRUCTURE <ls_row> TO <lv>.
        IF sy-subrc = 0 AND <lv> IS NOT INITIAL
           AND ls_c-type_kind CA 'CNDTgP'.          " printable types only
          WRITE: /5 ls_c-name, '=', <lv>.
        ENDIF.
      ENDLOOP.
      WRITE: /5 '----'.
    ENDLOOP.
    ULINE.
  ENDLOOP.
