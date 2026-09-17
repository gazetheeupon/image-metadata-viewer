// Turns the raw tag maps ExifParser produces into a human-readable, grouped
// report: decode tables for the common enumerated EXIF fields, GPS
// DMS-to-decimal conversion, and a fallback tag-name lookup for anything
// not specifically handled so "Other tags" is still readable rather than
// a wall of numbers.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MetadataReport = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var ORIENTATIONS = {
    1: "Normal", 2: "Mirrored horizontally", 3: "Rotated 180°",
    4: "Mirrored vertically", 5: "Mirrored horizontally, rotated 90° CW",
    6: "Rotated 90° CW", 7: "Mirrored horizontally, rotated 270° CW",
    8: "Rotated 270° CW",
  };

  var EXPOSURE_PROGRAMS = {
    0: "Not defined", 1: "Manual", 2: "Program AE", 3: "Aperture priority",
    4: "Shutter priority", 5: "Creative (biased toward depth of field)",
    6: "Action (biased toward fast shutter speed)", 7: "Portrait", 8: "Landscape",
  };

  var METERING_MODES = {
    0: "Unknown", 1: "Average", 2: "Center-weighted average", 3: "Spot",
    4: "Multi-spot", 5: "Pattern", 6: "Partial", 255: "Other",
  };

  var WHITE_BALANCE = { 0: "Auto", 1: "Manual" };

  var COLOR_SPACES = { 1: "sRGB", 65535: "Uncalibrated" };

  var RESOLUTION_UNITS = { 1: "None", 2: "Inches", 3: "Centimeters" };

  var FLASH_MODES = {
    0x0: "No flash", 0x1: "Fired", 0x5: "Fired, return not detected",
    0x7: "Fired, return detected", 0x8: "On, did not fire", 0x9: "On, fired",
    0xd: "On, return not detected", 0xf: "On, return detected",
    0x10: "Off, did not fire", 0x18: "Off, did not fire",
    0x19: "Off, fired", 0x1d: "Off, fired, return not detected",
    0x1f: "Off, fired, return detected", 0x20: "No flash function",
    0x41: "Auto, fired", 0x45: "Auto, fired, return not detected",
    0x47: "Auto, fired, return detected", 0x49: "Auto, on",
    0x4d: "Auto, on, return not detected", 0x4f: "Auto, on, return detected",
    0x50: "Auto, off, did not fire", 0x58: "Auto, off, did not fire",
    0x59: "Auto, off, fired", 0x5d: "Auto, off, fired, return not detected",
    0x5f: "Auto, off, fired, return detected",
  };

  // Tag-name lookup for everything the sections below don't already show
  // by name, so the "Other tags" table reads as names rather than numbers.
  var TAG_NAMES = {
    256: "ImageWidth", 257: "ImageHeight", 258: "BitsPerSample",
    259: "Compression", 262: "PhotometricInterpretation", 271: "Make",
    272: "Model", 274: "Orientation", 277: "SamplesPerPixel",
    282: "XResolution", 283: "YResolution", 284: "PlanarConfiguration",
    296: "ResolutionUnit", 301: "TransferFunction", 305: "Software",
    306: "DateTime", 315: "Artist", 316: "HostComputer", 318: "WhitePoint",
    319: "PrimaryChromaticities", 529: "YCbCrCoefficients",
    531: "YCbCrPositioning", 532: "ReferenceBlackWhite", 33432: "Copyright",
    33434: "ExposureTime", 33437: "FNumber", 34850: "ExposureProgram",
    34855: "ISOSpeedRatings", 34864: "SensitivityType", 34866: "RecommendedExposureIndex",
    36864: "ExifVersion", 36867: "DateTimeOriginal", 36868: "DateTimeDigitized",
    37121: "ComponentsConfiguration", 37122: "CompressedBitsPerPixel",
    37377: "ShutterSpeedValue", 37378: "ApertureValue", 37379: "BrightnessValue",
    37380: "ExposureBiasValue", 37381: "MaxApertureValue", 37382: "SubjectDistance",
    37383: "MeteringMode", 37384: "LightSource", 37385: "Flash",
    37386: "FocalLength", 37396: "SubjectArea", 37500: "MakerNote",
    37510: "UserComment", 37520: "SubSecTime", 37521: "SubSecTimeOriginal",
    37522: "SubSecTimeDigitized", 40960: "FlashpixVersion", 40961: "ColorSpace",
    40962: "PixelXDimension", 40963: "PixelYDimension", 40964: "RelatedSoundFile",
    41486: "FocalPlaneXResolution", 41487: "FocalPlaneYResolution",
    41488: "FocalPlaneResolutionUnit", 41495: "SensingMethod",
    41728: "FileSource", 41729: "SceneType", 41985: "CustomRendered",
    41986: "ExposureMode", 41987: "WhiteBalance", 41988: "DigitalZoomRatio",
    41989: "FocalLengthIn35mmFilm", 41990: "SceneCaptureType",
    41991: "GainControl", 41992: "Contrast", 41993: "Saturation",
    41994: "Sharpness", 41996: "SubjectDistanceRange",
    42016: "ImageUniqueID", 42032: "CameraOwnerName", 42033: "BodySerialNumber",
    42034: "LensSpecification", 42035: "LensMake", 42036: "LensModel",
    42037: "LensSerialNumber",
    // GPS IFD (these tag numbers overlap the ones above but are only ever
    // read out of the GPS sub-IFD map, which is kept separate)
    0: "GPSVersionID", 1: "GPSLatitudeRef", 2: "GPSLatitude", 3: "GPSLongitudeRef",
    4: "GPSLongitude", 5: "GPSAltitudeRef", 6: "GPSAltitude", 7: "GPSTimeStamp",
    8: "GPSSatellites", 9: "GPSStatus", 10: "GPSMeasureMode", 11: "GPSDOP",
    12: "GPSSpeedRef", 13: "GPSSpeed", 16: "GPSImgDirectionRef", 17: "GPSImgDirection",
    18: "GPSMapDatum", 23: "GPSDestBearingRef", 24: "GPSDestBearing", 29: "GPSDateStamp",
  };

  function fmtRational(v, digits) {
    if (typeof v !== "number") return v;
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(digits == null ? 2 : digits);
  }

  function fmtExposureTime(v) {
    if (typeof v !== "number" || !v) return null;
    if (v >= 1) return v.toFixed(1) + " s";
    var denom = Math.round(1 / v);
    return "1/" + denom + " s";
  }

  function dmsToDecimal(dms, ref) {
    if (!Array.isArray(dms) || dms.length < 3) return null;
    var dec = dms[0] + dms[1] / 60 + dms[2] / 3600;
    if (ref === "S" || ref === "W") dec = -dec;
    return dec;
  }

  function row(label, value) {
    return value == null || value === "" ? null : [label, value];
  }

  function compact(rows) {
    return rows.filter(function (r) { return r != null; });
  }

  // Builds the grouped, human-readable report from a {ifd0, exif, gps}
  // triple as produced by ExifParser.parseTIFF (and its callers). Any of
  // the three maps may be undefined/null.
  function buildTiffReport(tiff) {
    var ifd0 = (tiff && tiff.ifd0) || {};
    var exif = (tiff && tiff.exif) || {};
    var gps = (tiff && tiff.gps) || {};
    var sections = [];
    var consumedIfd0 = {}, consumedExif = {}, consumedGps = {};
    // These are internal pointers to the Exif/GPS sub-IFDs, not useful data.
    consumedIfd0[34665] = true;
    consumedIfd0[34853] = true;

    function take(map, consumed, tag) {
      consumed[tag] = true;
      return map[tag];
    }

    // ---- Camera ----
    var cameraRows = compact([
      row("Make", take(ifd0, consumedIfd0, 271)),
      row("Model", take(ifd0, consumedIfd0, 272)),
      row("Lens make", take(exif, consumedExif, 42035)),
      row("Lens model", take(exif, consumedExif, 42036)),
      row("Software", take(ifd0, consumedIfd0, 305)),
      (function () {
        var o = take(ifd0, consumedIfd0, 274);
        return row("Orientation", o == null ? null : (ORIENTATIONS[o] || "Unknown (" + o + ")"));
      })(),
      row("Date taken", take(exif, consumedExif, 36867) || take(exif, consumedExif, 36868)),
      row("Date modified", take(ifd0, consumedIfd0, 306)),
      row("Artist", take(ifd0, consumedIfd0, 315)),
      row("Copyright", take(ifd0, consumedIfd0, 33432)),
    ]);
    if (cameraRows.length) sections.push({ title: "Camera", rows: cameraRows });

    // ---- Exposure ----
    var exposureRows = compact([
      (function () {
        var v = take(exif, consumedExif, 33434);
        return row("Exposure time", fmtExposureTime(v));
      })(),
      (function () {
        var v = take(exif, consumedExif, 33437);
        return row("Aperture (f-number)", v == null ? null : "f/" + fmtRational(v, 1));
      })(),
      row("ISO", take(exif, consumedExif, 34855)),
      (function () {
        var v = take(exif, consumedExif, 37386);
        return row("Focal length", v == null ? null : fmtRational(v, 0) + " mm");
      })(),
      row("Focal length (35mm equiv.)", (function () {
        var v = take(exif, consumedExif, 41989);
        return v == null ? null : v + " mm";
      })()),
      (function () {
        var v = take(exif, consumedExif, 37380);
        return row("Exposure bias", v == null ? null : (v > 0 ? "+" : "") + fmtRational(v, 2) + " EV");
      })(),
      (function () {
        var v = take(exif, consumedExif, 34850);
        return row("Exposure program", v == null ? null : (EXPOSURE_PROGRAMS[v] || "Unknown (" + v + ")"));
      })(),
      (function () {
        var v = take(exif, consumedExif, 37383);
        return row("Metering mode", v == null ? null : (METERING_MODES[v] || "Unknown (" + v + ")"));
      })(),
      (function () {
        var v = take(exif, consumedExif, 37385);
        return row("Flash", v == null ? null : (FLASH_MODES[v] || ("Unknown (0x" + v.toString(16) + ")")));
      })(),
      (function () {
        var v = take(exif, consumedExif, 41987);
        return row("White balance", v == null ? null : (WHITE_BALANCE[v] || "Unknown (" + v + ")"));
      })(),
      (function () {
        var v = take(exif, consumedExif, 40961);
        return row("Color space", v == null ? null : (COLOR_SPACES[v] || "Unknown (" + v + ")"));
      })(),
    ]);
    if (exposureRows.length) sections.push({ title: "Exposure", rows: exposureRows });

    // ---- GPS ----
    var latRef = take(gps, consumedGps, 1), lat = take(gps, consumedGps, 2);
    var lonRef = take(gps, consumedGps, 3), lon = take(gps, consumedGps, 4);
    var altRef = take(gps, consumedGps, 5), alt = take(gps, consumedGps, 6);
    take(gps, consumedGps, 7); take(gps, consumedGps, 29); // timestamp/datestamp, folded into "Date" below if wanted
    var latDec = dmsToDecimal(lat, latRef), lonDec = dmsToDecimal(lon, lonRef);
    var gpsRows = [];
    var mapUrl = null;
    if (latDec != null && lonDec != null) {
      gpsRows.push(["Coordinates", latDec.toFixed(6) + ", " + lonDec.toFixed(6)]);
      mapUrl = "https://www.openstreetmap.org/?mlat=" + latDec.toFixed(6) + "&mlon=" + lonDec.toFixed(6) + "#map=15/" + latDec.toFixed(6) + "/" + lonDec.toFixed(6);
    }
    if (alt != null) {
      gpsRows.push(["Altitude", fmtRational(alt, 1) + " m" + (altRef === 1 ? " below sea level" : " above sea level")]);
    }
    if (gpsRows.length) sections.push({ title: "GPS location", rows: gpsRows, mapUrl: mapUrl });

    // ---- Other tags (anything left over) ----
    var otherRows = [];
    [[ifd0, consumedIfd0, ""], [exif, consumedExif, ""], [gps, consumedGps, "GPS "]].forEach(function (triple) {
      var map = triple[0], consumed = triple[1], prefix = triple[2];
      Object.keys(map).forEach(function (tagStr) {
        var tag = Number(tagStr);
        if (consumed[tag]) return;
        var name = TAG_NAMES[tag] ? prefix + TAG_NAMES[tag] : prefix + "Tag " + tag;
        var v = map[tag];
        if (Array.isArray(v)) v = v.map(function (x) { return fmtRational(x, 3); }).join(", ");
        else if (typeof v === "number") v = fmtRational(v, 3);
        otherRows.push([name, String(v)]);
      });
    });
    if (otherRows.length) sections.push({ title: "Other tags", rows: otherRows });

    return sections;
  }

  return {
    buildTiffReport: buildTiffReport,
    dmsToDecimal: dmsToDecimal,
  };
});
