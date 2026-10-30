*&---------------------------------------------------------------------*
*& Report ZMDG_BP_CR_TEST
*& Test ZCL_MDG_BP_CR_CREATE in S23/120 without Gateway or BTP (SE38 / F8).
*& Use this FIRST to validate the MDG part before building the OData service.
*&---------------------------------------------------------------------*
REPORT zmdg_bp_cr_test.

PARAMETERS:
  p_crtyp TYPE usmd_crequest_type DEFAULT 'ZBP1P1',
  p_categ TYPE bu_type            DEFAULT '1',
  p_name  TYPE string             LOWER CASE DEFAULT 'Otto Willy',
  p_street TYPE ad_street         LOWER CASE DEFAULT 'Teststraße',
  p_house TYPE ad_hsnm1           DEFAULT '1',
  p_pcode TYPE ad_pstcd1          DEFAULT '12345',
  p_city  TYPE ad_city1           LOWER CASE DEFAULT 'Testhausen',
  p_cntry TYPE land1              DEFAULT 'DE',
  p_taxty TYPE bptaxtype          DEFAULT 'DE0',
  p_taxnr TYPE bptaxnum.

START-OF-SELECTION.
  TRY.
      DATA(ls_res) = zcl_mdg_bp_cr_create=>create( VALUE #(
                       cr_type      = p_crtyp
                       description  = |AI upload test: { p_name }|
                       bp_category  = p_categ
                       name         = p_name
                       street       = p_street
                       house_number = p_house
                       postal_code  = p_pcode
                       city         = p_city
                       country      = p_cntry
                       tax_type     = COND #( WHEN p_taxnr IS INITIAL THEN '' ELSE p_taxty )
                       tax_number   = p_taxnr ) ).

      WRITE: / 'Change request:', ls_res-cr_number,
             / 'CR type       :', ls_res-cr_type,
             / 'CR status     :', ls_res-cr_status,
             / 'Temp BP       :', ls_res-bp_temp.
      ULINE.
      LOOP AT ls_res-messages INTO DATA(ls_msg).
        MESSAGE ID ls_msg-msgid TYPE 'S' NUMBER ls_msg-msgno
          WITH ls_msg-msgv1 ls_msg-msgv2 ls_msg-msgv3 ls_msg-msgv4 INTO DATA(lv_txt).
        WRITE: / ls_msg-msgty, lv_txt.
      ENDLOOP.

    CATCH cx_usmd_conv_som_gov_api cx_usmd_gov_api INTO DATA(lx).
      WRITE: / 'ERROR:', lx->get_text( ).
  ENDTRY.
