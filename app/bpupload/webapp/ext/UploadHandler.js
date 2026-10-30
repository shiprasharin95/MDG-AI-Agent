/**
 * Custom List Report action "Upload Customer Form".
 * Fiori elements calls onUpload with `this` = ExtensionAPI of the List Report.
 *
 *  Step 1  Upload picture in SAP CAP           -> POST /odata/v4/mdg-ai/uploadForm
 *  Step 2  AI extraction + duplicate check     -> backend (srv/mdg-ai-service.js)
 *  Step 3  Auto creation of CR in MDG          -> backend, if no duplicate
 */
sap.ui.define([
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Text",
  "sap/m/Label",
  "sap/m/Image",
  "sap/m/VBox",
  "sap/m/MessageStrip",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/ui/layout/form/SimpleForm",
  "sap/ui/unified/FileUploader",
  "sap/ui/core/BusyIndicator"
], function (Dialog, Button, Text, Label, Image, VBox, MessageStrip, MessageBox, MessageToast,
  SimpleForm, FileUploader, BusyIndicator) {
  "use strict";

  const MAX_SIZE = 20 * 1024 * 1024;
  const SERVICE = "/odata/v4/mdg-ai/";

  const readAsDataUrl = file => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

  async function csrfToken () {
    try {
      const res = await fetch(SERVICE, { method: "HEAD", headers: { "X-CSRF-Token": "Fetch" }, credentials: "include" });
      return res.headers.get("X-CSRF-Token") || "";
    } catch (e) { return ""; }
  }

  function text (api, key) {
    const m = api.getModel("i18n");
    return m ? m.getResourceBundle().getText(key) : key;
  }

  function refreshList (api) {
    try { api.refresh(); } catch (e) { api.getModel().refresh(); }
  }

  function navigate (api, id) {
    const ctx = api.getModel().bindContext(`/FormUploads(${id})`).getBoundContext();
    api.routing.navigate(ctx);
  }

  function showResult (api, d) {
    const map = {
      DUPLICATE: { state: "Warning", icon: "sap-icon://alert", key: "resultDuplicate" },
      CR_CREATED: { state: "Success", icon: "sap-icon://accept", key: "resultCr" },
      NO_MATCH: { state: "Information", icon: "sap-icon://hint", key: "resultNoMatch" },
      ERROR: { state: "Error", icon: "sap-icon://error", key: "resultError" }
    };
    const m = map[d.status_code] || map.NO_MATCH;
    const rows = [
      ["Extracted by", d.extractionMethod],
      ["Name", d.name],
      ["Address", `${d.street || ""} ${d.houseNumber || ""}, ${d.postalCode || ""} ${d.city || ""}, ${d.country || ""}`],
      ["Tax Number", d.taxNumber || "-"]
    ];
    if (d.matchedPartner) rows.push(["Existing BP", `${d.matchedPartner} - ${d.matchReason}`]);
    if (d.crNumber) rows.push(["MDG Change Request", `${d.crNumber} (type ${d.crType})`]);

    const form = new SimpleForm({ editable: false, layout: "ResponsiveGridLayout", labelSpanM: 4, labelSpanL: 4 });
    rows.forEach(([l, v]) => { form.addContent(new Label({ text: l })); form.addContent(new Text({ text: v })); });

    const dlg = new Dialog({
      title: text(api, m.key),
      state: m.state,
      icon: m.icon,
      contentWidth: "600px",
      content: new VBox({ items: [
        new MessageStrip({ text: d.message, type: m.state, showIcon: true }).addStyleClass("sapUiSmallMargin"),
        form
      ] }),
      beginButton: new Button({ text: text(api, "openDetails"), type: "Emphasized", press: () => { dlg.close(); navigate(api, d.ID); } }),
      endButton: new Button({ text: "Close", press: () => dlg.close() }),
      afterClose: () => dlg.destroy()
    });
    dlg.open();
  }

  async function process (api, file) {
    BusyIndicator.show(0);
    MessageToast.show(text(api, "uploadProcessing"));
    try {
      const content = await readAsDataUrl(file);
      const token = await csrfToken();
      const res = await fetch(SERVICE + "uploadForm", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": token },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg"),
          content: content.split(",")[1]
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.error && data.error.message) || res.statusText);
      refreshList(api);
      showResult(api, data);
    } catch (e) {
      MessageBox.error(e.message, { title: text(api, "resultError") });
    } finally {
      BusyIndicator.hide();
    }
  }

  return {
    onUpload: function () {
      const api = this;
      let selectedFile = null;

      const preview = new Image({ width: "100%", height: "280px", mode: "Background", backgroundSize: "contain", visible: false });
      const fileInfo = new Text({ visible: false });

      const dialog = new Dialog({
        title: text(api, "uploadTitle"),
        contentWidth: "560px",
        draggable: true,
        resizable: true,
        afterClose: () => dialog.destroy()
      });

      const uploader = new FileUploader({
        width: "100%",
        placeholder: text(api, "uploadPlaceholder"),
        fileType: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "pdf"],
        maximumFileSize: 20,
        sameFilenameAllowed: true,
        buttonText: "Browse...",
        change: e => {
          const files = e.getParameter("files");
          selectedFile = files && files[0];
          dialog.getBeginButton().setEnabled(!!selectedFile);
          if (!selectedFile) { preview.setVisible(false); fileInfo.setVisible(false); return; }
          fileInfo.setText(`${selectedFile.name} - ${Math.round(selectedFile.size / 1024)} KB`).setVisible(true);
          if (selectedFile.type.startsWith("image/")) preview.setSrc(URL.createObjectURL(selectedFile)).setVisible(true);
          else preview.setVisible(false);
        },
        fileSizeExceed: () => MessageToast.show(text(api, "uploadTooLarge")),
        typeMissmatch: () => MessageToast.show("Unsupported file type - use JPG, PNG or PDF")
      });

      dialog.addContent(new VBox({ items: [
        new MessageStrip({ text: text(api, "uploadHint"), showIcon: true, type: "Information" }).addStyleClass("sapUiSmallMarginBottom"),
        uploader,
        fileInfo.addStyleClass("sapUiTinyMarginTop"),
        preview.addStyleClass("sapUiSmallMarginTop")
      ] }).addStyleClass("sapUiSmallMargin"));

      dialog.setBeginButton(new Button({
        text: text(api, "uploadStart"),
        type: "Emphasized",
        icon: "sap-icon://upload",
        enabled: false,
        press: () => {
          if (!selectedFile) return MessageToast.show(text(api, "uploadNoFile"));
          if (selectedFile.size > MAX_SIZE) return MessageToast.show(text(api, "uploadTooLarge"));
          const f = selectedFile;
          dialog.close();
          process(api, f);
        }
      }));
      dialog.setEndButton(new Button({ text: text(api, "uploadCancel"), press: () => dialog.close() }));
      dialog.open();
    }
  };
});
