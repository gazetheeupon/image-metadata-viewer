(function () {
  "use strict";

  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("fileInput");
  var fnameEl = document.getElementById("fname");
  var statusEl = document.getElementById("status");
  var mismatchCard = document.getElementById("mismatchCard");
  var mismatchText = document.getElementById("mismatchText");
  var basicCard = document.getElementById("basicCard");
  var basicBody = document.getElementById("basicBody");
  var sectionsWrap = document.getElementById("sectionsWrap");
  var textCard = document.getElementById("textCard");
  var textBody = document.getElementById("textBody");

  function setStatus(msg, isError) {
    statusEl.textContent = msg || "";
    statusEl.className = isError ? "error" : "";
  }

  function resetUI() {
    mismatchCard.style.display = "none";
    basicCard.style.display = "none";
    textCard.style.display = "none";
    basicBody.innerHTML = "";
    textBody.innerHTML = "";
    sectionsWrap.innerHTML = "";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }

  function extOf(filename) {
    var m = /\.([a-z0-9]+)$/i.exec(filename || "");
    return m ? "." + m[1].toLowerCase() : "";
  }

  // Which claimed extensions are consistent with a detected format. Broader
  // than ExifParser's own `extensions` list in a couple of cases (jpg/jpeg,
  // tif/tiff, heic/heif are used interchangeably in the wild).
  var COMPATIBLE_EXT = {
    JPEG: [".jpg", ".jpeg", ".jpe", ".jfif"],
    PNG: [".png"],
    GIF: [".gif"],
    BMP: [".bmp", ".dib"],
    WEBP: [".webp"],
    TIFF: [".tif", ".tiff"],
    HEIC: [".heic", ".heif"],
    HEIF: [".heic", ".heif"],
    AVIF: [".avif"],
  };

  function renderTable(rows) {
    var html = "<table><tbody>";
    rows.forEach(function (r) {
      html += "<tr><th>" + escapeHtml(r[0]) + "</th><td>" + escapeHtml(r[1]) + "</td></tr>";
    });
    html += "</tbody></table>";
    return html;
  }

  function renderSections(sections) {
    sectionsWrap.innerHTML = "";
    sections.forEach(function (sec) {
      var card = document.createElement("div");
      card.className = "card section";
      var h = document.createElement("h2");
      h.textContent = sec.title;
      card.appendChild(h);
      var tableWrap = document.createElement("div");
      tableWrap.innerHTML = renderTable(sec.rows);
      card.appendChild(tableWrap);
      if (sec.mapUrl) {
        var a = document.createElement("a");
        a.href = sec.mapUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "maplink";
        a.textContent = "Open in OpenStreetMap →";
        card.appendChild(a);
      }
      sectionsWrap.appendChild(card);
    });
  }

  function handleFile(file) {
    resetUI();
    fnameEl.textContent = file.name;
    setStatus("Reading file...");

    file.arrayBuffer().then(function (buffer) {
      var det;
      try {
        det = ExifParser.detectFormat(buffer);
      } catch (e) {
        setStatus("Could not read this file: " + e.message, true);
        return;
      }

      if (det.format === "UNKNOWN") {
        setStatus("This doesn't look like a supported image format (no recognizable file signature was found).", true);
        return;
      }

      // The payoff feature: compare what the file's own bytes say it is
      // against what its extension claims. This is exactly the situation
      // the HEIC to JPG converter's FAQ warns about — a camera or app that
      // labels an already-JPEG file with a .HEIC extension (or the reverse).
      var claimedExt = extOf(file.name);
      var compatible = COMPATIBLE_EXT[det.format] || [];
      if (claimedExt && compatible.length && compatible.indexOf(claimedExt) === -1) {
        mismatchCard.style.display = "";
        mismatchText.innerHTML =
          "This file is named <strong>" + escapeHtml(claimedExt) + "</strong>, but its actual content is a <strong>" +
          escapeHtml(det.label) + "</strong> file, not " + escapeHtml(claimedExt) + ". " +
          "Some cameras and apps mislabel files this way &mdash; most commonly an already-JPEG photo saved with a " +
          "<code>.HEIC</code> extension. Rename the file to match its real format (or run it through the " +
          "<a href=\"https://gazetheeupon.github.io/heic-to-jpg/\">HEIC to JPG converter</a> if you actually need a HEIC-to-JPEG conversion) " +
          "before relying on file-type checks elsewhere.";
      }

      var basicRows = [["Detected format", det.label]];
      var width = null, height = null, tiff = null, textChunks = null;

      try {
        switch (det.format) {
          case "JPEG": {
            var jr = ExifParser.parseJPEG(buffer);
            width = jr.width; height = jr.height; tiff = jr.tiff;
            break;
          }
          case "PNG": {
            var pr = ExifParser.parsePNG(buffer);
            width = pr.width; height = pr.height; tiff = pr.tiff; textChunks = pr.textChunks;
            break;
          }
          case "TIFF": {
            tiff = ExifParser.parseTIFF(buffer, 0);
            break;
          }
          case "HEIC": case "HEIF": {
            var hr = ExifParser.parseHEIF(buffer);
            tiff = hr.tiff;
            break;
          }
          case "AVIF": {
            var ar = ExifParser.parseHEIF(buffer);
            tiff = ar.tiff;
            break;
          }
          case "WEBP": {
            var wr = ExifParser.parseWebP(buffer);
            width = wr.width; height = wr.height; tiff = wr.tiff;
            break;
          }
          case "GIF": {
            var gr = ExifParser.parseGIF(buffer);
            width = gr.width; height = gr.height;
            break;
          }
          case "BMP": {
            var br = ExifParser.parseBMP(buffer);
            width = br.width; height = br.height;
            break;
          }
        }
      } catch (e) {
        setStatus("Read the file header, but hit an error parsing its metadata: " + e.message, true);
      }

      if (tiff && tiff.ifd0 && tiff.ifd0[256] != null && width == null) width = tiff.ifd0[256].value;
      if (tiff && tiff.ifd0 && tiff.ifd0[257] != null && height == null) height = tiff.ifd0[257].value;

      if (width != null && height != null) basicRows.push(["Dimensions", width + " × " + height + " px"]);
      basicRows.push(["File size", file.size.toLocaleString() + " bytes"]);

      basicBody.innerHTML = "";
      basicCard.style.display = "";
      var basicHtml = renderTable(basicRows);
      basicBody.innerHTML = basicHtml;

      var sections = (tiff && (Object.keys(tiff.ifd0 || {}).length || Object.keys(tiff.exif || {}).length || Object.keys(tiff.gps || {}).length))
        ? MetadataReport.buildTiffReport(tiff)
        : [];
      renderSections(sections);

      if (textChunks && textChunks.length) {
        textCard.style.display = "";
        textBody.innerHTML = renderTable(textChunks.map(function (c) { return [c.keyword, c.text]; }));
      }

      if (!sections.length && !(textChunks && textChunks.length)) {
        setStatus(
          det.format === "GIF" || det.format === "BMP"
            ? "No EXIF metadata to show — " + det.label + " files don't carry EXIF data."
            : "No EXIF or text metadata was found in this file."
        );
      } else {
        setStatus("");
      }
    }).catch(function (e) {
      setStatus("Could not read file: " + e.message, true);
    });
  }

  // ---- file input wiring ----
  dropzone.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add("drag"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove("drag"); });
  });
  dropzone.addEventListener("drop", function (e) {
    var file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
})();
