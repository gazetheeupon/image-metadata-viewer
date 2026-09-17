// Pure-JS image metadata (EXIF/TIFF) reader.
//
// Supports: JPEG (APP1 Exif segment), TIFF (native TIFF/EXIF structure),
// PNG (eXIf chunk + tEXt/zTXt/iTXt text chunks), HEIC/HEIF/AVIF (ISOBMFF
// 'meta' box -> 'iinf'/'iloc' -> Exif item -> same TIFF structure), and
// format detection by magic bytes for GIF/BMP/WebP (dimensions only; WebP's
// EXIF chunk, when present, is also read).
//
// Detecting the real format from file *content* rather than its extension
// is the point of this tool as much as the tag values are: a camera or app
// mislabeling a JPEG as .heic (or vice versa) is a real, common situation.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ExifParser = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Format detection by magic bytes
  // ---------------------------------------------------------------------

  function bytesEqual(bytes, offset, arr) {
    if (offset + arr.length > bytes.length) return false;
    for (var i = 0; i < arr.length; i++) if (bytes[offset + i] !== arr[i]) return false;
    return true;
  }
  function asciiAt(bytes, offset, len) {
    var s = "";
    for (var i = 0; i < len && offset + i < bytes.length; i++) s += String.fromCharCode(bytes[offset + i]);
    return s;
  }

  var HEIF_BRANDS = {
    heic: "HEIC", heix: "HEIC", heim: "HEIC", heis: "HEIC",
    hevc: "HEIC", hevx: "HEIC", hevm: "HEIC", hevs: "HEIC",
    mif1: "HEIF", msf1: "HEIF",
    avif: "AVIF", avis: "AVIF",
  };

  function detectFormat(buf) {
    var b = new Uint8Array(buf, 0, Math.min(64, buf.byteLength));
    if (bytesEqual(b, 0, [0xff, 0xd8, 0xff])) {
      return { format: "JPEG", label: "JPEG", extensions: [".jpg", ".jpeg"] };
    }
    if (bytesEqual(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      return { format: "PNG", label: "PNG", extensions: [".png"] };
    }
    if (asciiAt(b, 0, 6) === "GIF87a" || asciiAt(b, 0, 6) === "GIF89a") {
      return { format: "GIF", label: "GIF", extensions: [".gif"] };
    }
    if (asciiAt(b, 0, 2) === "BM") {
      return { format: "BMP", label: "BMP", extensions: [".bmp"] };
    }
    if (asciiAt(b, 0, 4) === "RIFF" && asciiAt(b, 8, 4) === "WEBP") {
      return { format: "WEBP", label: "WebP", extensions: [".webp"] };
    }
    if (bytesEqual(b, 0, [0x49, 0x49, 0x2a, 0x00]) || bytesEqual(b, 0, [0x4d, 0x4d, 0x00, 0x2a])) {
      return { format: "TIFF", label: "TIFF", extensions: [".tif", ".tiff"] };
    }
    if (b.length >= 12 && asciiAt(b, 4, 4) === "ftyp") {
      var brand = asciiAt(b, 8, 4).replace(/\0/g, "").toLowerCase();
      var mapped = HEIF_BRANDS[brand];
      if (mapped) {
        return { format: mapped, label: mapped, extensions: mapped === "AVIF" ? [".avif"] : [".heic", ".heif"], brand: brand };
      }
      // Unknown ftyp brand — still an ISOBMFF-family container (could be a
      // newer/rarer HEIF variant), so still worth trying the same box walk.
      return { format: "HEIF", label: "HEIF-family container", extensions: [".heic", ".heif"], brand: brand, unknownBrand: true };
    }
    return { format: "UNKNOWN", label: "Unrecognized format", extensions: [] };
  }

  // ---------------------------------------------------------------------
  // TIFF / EXIF / GPS IFD parsing — shared by JPEG, TIFF, PNG's eXIf chunk,
  // and HEIC/AVIF's Exif item.
  // ---------------------------------------------------------------------

  var TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function readIFD(dv, ifdOffset, little, tiffBase) {
    var entries = {};
    var numEntries = dv.getUint16(ifdOffset, little);
    for (var i = 0; i < numEntries; i++) {
      var entryOff = ifdOffset + 2 + i * 12;
      if (entryOff + 12 > dv.byteLength) break; // truncated IFD, stop reading entries
      var tag = dv.getUint16(entryOff, little);
      var type = dv.getUint16(entryOff + 2, little);
      var count = dv.getUint32(entryOff + 4, little);
      var typeSize = TYPE_SIZES[type];
      if (!typeSize) continue; // unknown/invalid type, skip
      var totalBytes = typeSize * count;
      var valueOffset = totalBytes <= 4 ? entryOff + 8 : tiffBase + dv.getUint32(entryOff + 8, little);
      var values = [];
      for (var j = 0; j < count; j++) {
        var off = valueOffset + j * typeSize;
        if (off + typeSize > dv.byteLength) break;
        switch (type) {
          case 1: values.push(dv.getUint8(off)); break; // BYTE
          case 2: break; // ASCII handled separately below
          case 3: values.push(dv.getUint16(off, little)); break; // SHORT
          case 4: values.push(dv.getUint32(off, little)); break; // LONG
          case 5: values.push(dv.getUint32(off, little) / (dv.getUint32(off + 4, little) || 1)); break; // RATIONAL
          case 6: values.push(dv.getInt8(off)); break; // SBYTE
          case 7: values.push(dv.getUint8(off)); break; // UNDEFINED (byte-wise)
          case 8: values.push(dv.getInt16(off, little)); break; // SSHORT
          case 9: values.push(dv.getInt32(off, little)); break; // SLONG
          case 10: values.push(dv.getInt32(off, little) / (dv.getInt32(off + 4, little) || 1)); break; // SRATIONAL
          case 11: values.push(dv.getFloat32(off, little)); break; // FLOAT
          case 12: values.push(dv.getFloat64(off, little)); break; // DOUBLE
        }
      }
      var value;
      if (type === 2) {
        var strBytes = new Uint8Array(dv.buffer, valueOffset, Math.min(totalBytes, dv.byteLength - valueOffset));
        var s = "";
        for (var k = 0; k < strBytes.length; k++) {
          if (strBytes[k] === 0) break;
          s += String.fromCharCode(strBytes[k]);
        }
        value = s;
      } else if (type === 5 || type === 10) {
        // keep the raw numerator/denominator for the first rational too, for display fidelity
        value = values.length === 1 ? values[0] : values;
      } else {
        value = values.length === 1 ? values[0] : values;
      }
      entries[tag] = { type: type, count: count, value: value };
    }
    var nextIfdOffsetPos = ifdOffset + 2 + numEntries * 12;
    var nextIfdOffset = (nextIfdOffsetPos + 4 <= dv.byteLength) ? dv.getUint32(nextIfdOffsetPos, little) : 0;
    return { entries: entries, nextIfdOffset: nextIfdOffset };
  }

  // Parses a TIFF-structured buffer starting at `start` (the byte offset of
  // the "II"/"MM" byte-order mark within `buf`). Returns {ifd0, exif, gps,
  // little} where each of ifd0/exif/gps is a plain {tagNumber: value} map,
  // or null if this doesn't look like valid TIFF data.
  function parseTIFF(buf, start) {
    start = start || 0;
    if (start + 8 > buf.byteLength) return null;
    var dv = new DataView(buf);
    var b0 = dv.getUint8(start), b1 = dv.getUint8(start + 1);
    var little;
    if (b0 === 0x49 && b1 === 0x49) little = true;
    else if (b0 === 0x4d && b1 === 0x4d) little = false;
    else return null;
    var magic = dv.getUint16(start + 2, little);
    if (magic !== 42) return null;
    var ifd0Offset = start + dv.getUint32(start + 4, little);

    var ifd0Result;
    try {
      ifd0Result = readIFD(dv, ifd0Offset, little, start);
    } catch (e) {
      return null;
    }
    var ifd0 = {};
    for (var tag in ifd0Result.entries) ifd0[tag] = ifd0Result.entries[tag].value;

    var exif = null, gps = null;
    if (ifd0[34665] !== undefined) {
      try {
        var exifIfdOffset = start + ifd0[34665];
        var exifResult = readIFD(dv, exifIfdOffset, little, start);
        exif = {};
        for (var t2 in exifResult.entries) exif[t2] = exifResult.entries[t2].value;
      } catch (e) { /* leave exif null */ }
    }
    if (ifd0[34853] !== undefined) {
      try {
        var gpsIfdOffset = start + ifd0[34853];
        var gpsResult = readIFD(dv, gpsIfdOffset, little, start);
        gps = {};
        for (var t3 in gpsResult.entries) gps[t3] = gpsResult.entries[t3].value;
      } catch (e) { /* leave gps null */ }
    }

    return { ifd0: ifd0, exif: exif, gps: gps, little: little };
  }

  // ---------------------------------------------------------------------
  // JPEG: walk markers to find the SOF (dimensions) and APP1 Exif segment.
  // ---------------------------------------------------------------------

  function parseJPEG(buf) {
    var dv = new DataView(buf);
    if (dv.getUint16(0) !== 0xffd8) return null;
    var offset = 2;
    var result = { width: null, height: null, tiff: null, hasICC: false, hasXMP: false };
    while (offset < dv.byteLength - 4) {
      if (dv.getUint8(offset) !== 0xff) { offset++; continue; }
      var marker = dv.getUint8(offset + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      if (marker === 0xd9) break; // EOI
      var segLen = dv.getUint16(offset + 2);
      var segStart = offset + 4;
      if (marker === 0xe1) { // APP1
        var sig = asciiAt(new Uint8Array(buf), segStart, 6);
        if (sig === "Exif\0\0" || sig.indexOf("Exif") === 0) {
          var tiffStart = segStart + 6;
          if (!result.tiff) result.tiff = parseTIFF(buf, tiffStart);
        } else if (asciiAt(new Uint8Array(buf), segStart, 29) === "http://ns.adobe.com/xap/1.0/\0".slice(0, 29)) {
          result.hasXMP = true;
        }
      } else if (marker === 0xe2) { // APP2 — often ICC profile
        var sig2 = asciiAt(new Uint8Array(buf), segStart, 11);
        if (sig2 === "ICC_PROFILE") result.hasICC = true;
      } else if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        // SOFn: precision(1) height(2) width(2)
        result.height = dv.getUint16(segStart + 1);
        result.width = dv.getUint16(segStart + 3);
      }
      offset = segStart + segLen - 2;
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // PNG: IHDR + tEXt/zTXt/iTXt + eXIf chunk.
  // ---------------------------------------------------------------------

  function parsePNG(buf) {
    var dv = new DataView(buf);
    var result = { width: null, height: null, bitDepth: null, colorType: null, textChunks: [], tiff: null };
    var offset = 8; // skip signature
    var bytes = new Uint8Array(buf);
    while (offset + 8 <= dv.byteLength) {
      var length = dv.getUint32(offset);
      var type = asciiAt(bytes, offset + 4, 4);
      var dataStart = offset + 8;
      if (type === "IHDR") {
        result.width = dv.getUint32(dataStart);
        result.height = dv.getUint32(dataStart + 4);
        result.bitDepth = dv.getUint8(dataStart + 8);
        result.colorType = dv.getUint8(dataStart + 9);
      } else if (type === "tEXt") {
        var chunk = bytes.subarray(dataStart, dataStart + length);
        var nul = chunk.indexOf(0);
        if (nul >= 0) {
          result.textChunks.push({
            keyword: asciiAt(chunk, 0, nul),
            text: asciiAt(chunk, nul + 1, chunk.length - nul - 1),
          });
        }
      } else if (type === "iTXt") {
        var chunk2 = bytes.subarray(dataStart, dataStart + length);
        var nul2 = chunk2.indexOf(0);
        if (nul2 >= 0) {
          // keyword \0 compressionFlag compressionMethod langTag\0 translatedKeyword\0 text
          var rest = chunk2.subarray(nul2 + 3);
          var nul3 = rest.indexOf(0);
          var rest2 = nul3 >= 0 ? rest.subarray(nul3 + 1) : rest;
          var nul4 = rest2.indexOf(0);
          var textBytes = nul4 >= 0 ? rest2.subarray(nul4 + 1) : rest2;
          result.textChunks.push({
            keyword: asciiAt(chunk2, 0, nul2),
            text: typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8").decode(textBytes) : asciiAt(textBytes, 0, textBytes.length),
          });
        }
      } else if (type === "eXIf") {
        result.tiff = parseTIFF(buf, dataStart);
      } else if (type === "IEND") {
        break;
      }
      offset = dataStart + length + 4; // +4 for CRC
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // HEIC/HEIF/AVIF: ISOBMFF box walk -> meta -> iinf + iloc -> Exif item.
  // ---------------------------------------------------------------------

  function walkTopBoxes(dv, start, end) {
    var boxes = [];
    var off = start;
    while (off + 8 <= end) {
      var size = dv.getUint32(off);
      var type = asciiAt(new Uint8Array(dv.buffer), off + 4, 4);
      var hdr = 8;
      var boxSize;
      if (size === 1) {
        boxSize = Number(dv.getBigUint64(off + 8));
        hdr = 16;
      } else if (size === 0) {
        boxSize = end - off;
      } else {
        boxSize = size;
      }
      if (boxSize < hdr) break; // corrupt, bail
      boxes.push({ type: type, start: off, headerSize: hdr, contentStart: off + hdr, end: off + boxSize });
      off += boxSize;
    }
    return boxes;
  }

  function parseIinf(dv, box) {
    var off = box.contentStart;
    var version = dv.getUint8(off);
    off += 4; // version(1) + flags(3)
    var entryCount = version === 0 ? dv.getUint16(off) : dv.getUint32(off);
    off += version === 0 ? 2 : 4;
    var exifItemId = null;
    for (var i = 0; i < entryCount && off + 8 <= box.end; i++) {
      var infeSize = dv.getUint32(off);
      var infeType = asciiAt(new Uint8Array(dv.buffer), off + 4, 4);
      if (infeType !== "infe") { off += infeSize; continue; }
      var infeVersion = dv.getUint8(off + 8);
      var p = off + 12; // skip size(4)+type(4)+version(1)+flags(3)
      var itemId, itemType;
      if (infeVersion >= 2) {
        itemId = infeVersion === 3 ? dv.getUint32(p) : dv.getUint16(p);
        p += infeVersion === 3 ? 4 : 2;
        p += 2; // item_protection_index
        itemType = asciiAt(new Uint8Array(dv.buffer), p, 4);
      }
      if (itemType === "Exif") exifItemId = itemId;
      off += infeSize;
    }
    return exifItemId;
  }

  function parseIloc(dv, box, targetItemId) {
    var off = box.contentStart;
    var version = dv.getUint8(off);
    off += 4;
    var sizesByte1 = dv.getUint8(off), sizesByte2 = dv.getUint8(off + 1);
    off += 2;
    var offsetSize = sizesByte1 >> 4, lengthSize = sizesByte1 & 0xf;
    var baseOffsetSize = sizesByte2 >> 4, indexSize = sizesByte2 & 0xf;
    var itemCount = version < 2 ? dv.getUint16(off) : dv.getUint32(off);
    off += version < 2 ? 2 : 4;

    function readUintN(o, n) {
      if (n === 0) return 0;
      var v = 0;
      for (var i = 0; i < n; i++) v = v * 256 + dv.getUint8(o + i);
      return v;
    }

    for (var i = 0; i < itemCount && off < box.end; i++) {
      var itemId = version < 2 ? dv.getUint16(off) : dv.getUint32(off);
      off += version < 2 ? 2 : 4;
      var constructionMethod = 0;
      if (version === 1 || version === 2) { constructionMethod = dv.getUint16(off) & 0xf; off += 2; }
      off += 2; // data_reference_index
      var baseOffset = readUintN(off, baseOffsetSize); off += baseOffsetSize;
      var extentCount = dv.getUint16(off); off += 2;
      var firstExtentOffset = null, firstExtentLength = null;
      for (var e = 0; e < extentCount; e++) {
        if ((version === 1 || version === 2) && indexSize > 0) off += indexSize;
        var extOffset = readUintN(off, offsetSize); off += offsetSize;
        var extLength = readUintN(off, lengthSize); off += lengthSize;
        if (e === 0) { firstExtentOffset = extOffset; firstExtentLength = extLength; }
      }
      if (itemId === targetItemId) {
        if (constructionMethod !== 0) return { unsupportedConstruction: true };
        return { offset: baseOffset + firstExtentOffset, length: firstExtentLength };
      }
    }
    return null;
  }

  function parseHEIF(buf) {
    var dv = new DataView(buf);
    var topBoxes = walkTopBoxes(dv, 0, buf.byteLength);
    var metaBox = null;
    for (var i = 0; i < topBoxes.length; i++) if (topBoxes[i].type === "meta") metaBox = topBoxes[i];
    if (!metaBox) return { tiff: null, note: "no 'meta' box found" };

    // meta is a full box: version(1)+flags(3) then child boxes
    var metaChildren = walkTopBoxes(dv, metaBox.contentStart + 4, metaBox.end);
    var iinfBox = null, ilocBox = null;
    for (var j = 0; j < metaChildren.length; j++) {
      if (metaChildren[j].type === "iinf") iinfBox = metaChildren[j];
      if (metaChildren[j].type === "iloc") ilocBox = metaChildren[j];
    }
    if (!iinfBox || !ilocBox) return { tiff: null, note: "no Exif item info found" };

    var exifItemId = parseIinf(dv, iinfBox);
    if (exifItemId === null) return { tiff: null, note: "no item of type 'Exif' found" };

    var loc = parseIloc(dv, ilocBox, exifItemId);
    if (!loc || loc.unsupportedConstruction) return { tiff: null, note: "Exif item location could not be resolved" };

    if (loc.offset + loc.length > buf.byteLength) return { tiff: null, note: "Exif item extends past end of file" };

    // HEIF Exif items are prefixed with a 4-byte big-endian offset (from
    // right after that field) to where the actual TIFF header begins,
    // mirroring the "Exif\0\0" skip in a JPEG APP1 segment.
    var headerOffsetField = dv.getUint32(loc.offset);
    var tiffStart = loc.offset + 4 + headerOffsetField;
    return { tiff: parseTIFF(buf, tiffStart) };
  }

  // ---------------------------------------------------------------------
  // WebP: RIFF chunk walk for dimensions + an optional EXIF chunk.
  // ---------------------------------------------------------------------

  function parseWebP(buf) {
    var dv = new DataView(buf);
    var result = { width: null, height: null, tiff: null };
    var off = 12; // past "RIFF"+size+"WEBP"
    while (off + 8 <= dv.byteLength) {
      var fourcc = asciiAt(new Uint8Array(buf), off, 4);
      var chunkSize = dv.getUint32(off + 4, true);
      var dataStart = off + 8;
      if (fourcc === "VP8 " && dataStart + 10 <= dv.byteLength) {
        result.width = dv.getUint16(dataStart + 6, true) & 0x3fff;
        result.height = dv.getUint16(dataStart + 8, true) & 0x3fff;
      } else if (fourcc === "VP8L" && dataStart + 5 <= dv.byteLength) {
        var b0 = dv.getUint8(dataStart + 1), b1 = dv.getUint8(dataStart + 2), b2 = dv.getUint8(dataStart + 3), b3 = dv.getUint8(dataStart + 4);
        result.width = 1 + (((b1 & 0x3f) << 8) | b0);
        result.height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      } else if (fourcc === "VP8X" && dataStart + 10 <= dv.byteLength) {
        result.width = 1 + (dv.getUint8(dataStart + 4) | (dv.getUint8(dataStart + 5) << 8) | (dv.getUint8(dataStart + 6) << 16));
        result.height = 1 + (dv.getUint8(dataStart + 7) | (dv.getUint8(dataStart + 8) << 8) | (dv.getUint8(dataStart + 9) << 16));
      } else if (fourcc === "EXIF") {
        var sig = asciiAt(new Uint8Array(buf), dataStart, 6);
        var tiffStart = sig === "Exif\0\0" ? dataStart + 6 : dataStart;
        result.tiff = parseTIFF(buf, tiffStart);
      }
      off = dataStart + chunkSize + (chunkSize % 2); // chunks are padded to even size
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // GIF / BMP: dimensions only (neither format carries EXIF).
  // ---------------------------------------------------------------------

  function parseGIF(buf) {
    var dv = new DataView(buf);
    if (dv.byteLength < 10) return { width: null, height: null };
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }

  function parseBMP(buf) {
    var dv = new DataView(buf);
    if (dv.byteLength < 26) return { width: null, height: null };
    // BITMAPFILEHEADER (14 bytes) + BITMAPINFOHEADER's first fields.
    // The classic BITMAPINFOHEADER (and its common successors) all start
    // with a 4-byte header size, then int32 width, int32 height (which can
    // be negative for a top-down image; we report the magnitude).
    var width = dv.getInt32(18, true);
    var height = dv.getInt32(22, true);
    return { width: width, height: Math.abs(height) };
  }

  return {
    detectFormat: detectFormat,
    parseTIFF: parseTIFF,
    parseJPEG: parseJPEG,
    parsePNG: parsePNG,
    parseHEIF: parseHEIF,
    parseWebP: parseWebP,
    parseGIF: parseGIF,
    parseBMP: parseBMP,
  };
});
