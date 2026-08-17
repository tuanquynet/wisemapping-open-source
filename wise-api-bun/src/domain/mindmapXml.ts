import { BadRequestError } from "./errors.ts";

/**
 * Mindmap XML: storage encoding, validation, and the default document.
 */

/** From `model/MindmapUtils.MAX_SUPPORTED_NODES`. */
export const MAX_SUPPORTED_NODES = 4000;

/**
 * The storage seam.
 *
 * The Java app wraps map XML in a single-entry ZIP named "content"
 * (`util/ZipUtils.java`) and stores the bytes in a BYTEA/LONGVARBINARY column.
 * That existed for on-disk compatibility, which the greenfield decision
 * discards, so XML is stored as plain UTF-8 TEXT: `sqlite3 db "select xml ..."`,
 * grep, and data-fix scripts all keep working on the thing this system exists to
 * store.
 *
 * These two functions are the only place storage encoding is decided. Switching
 * to `Bun.gzipSync` later means changing them, two column types, and adding one
 * migration -- nothing else calls the codec.
 */
export function encodeXml(xml: string): string {
  return xml;
}

export function decodeXml(stored: string): string {
  return stored;
}

/**
 * Validates map XML, porting `model/MindmapUtils.verifyMindmap` exactly.
 *
 * Note what this does *not* do: `mindmap.xsd` exists in the Java resources but
 * is referenced nowhere in that codebase. Validating against it here would
 * reject documents the current server accepts, so it stays unused.
 *
 * The `<topic` count is deliberately the Java one, including its off-by-one:
 * `split` returns one element more than the number of separators, and the
 * `=== 0` lower bound in the original is dead code because `String.split` never
 * returns an empty array. Reproduced as a comment rather than as dead code.
 */
export function validateMindmapXml(xml: unknown): string {
  if (typeof xml !== "string" || xml.trim() === "") {
    throw new BadRequestError("The mindmap is empty.");
  }

  const trimmed = xml.trim();
  if (!trimmed.startsWith("<map") || !trimmed.endsWith("</map>")) {
    throw new BadRequestError("The mindmap format is invalid.");
  }

  const topicCount = trimmed.split("<topic").length;
  if (topicCount > MAX_SUPPORTED_NODES) {
    throw new BadRequestError(
      `The mindmap is too big. It contains ${topicCount} nodes and the maximum supported is ${MAX_SUPPORTED_NODES}.`,
    );
  }

  return xml;
}

/**
 * The `</map>`-suffix check that `MindmapServiceImpl.updateMindmap` applies on
 * top of full validation, on the trimmed string.
 */
export function assertClosesMapTag(xml: string): void {
  if (!xml.trim().endsWith("</map>")) {
    throw new BadRequestError("Map seems not to be a valid mindmap.");
  }
}

/**
 * Escapes a title for use in an XML attribute.
 *
 * NOTE: the Java original (`Mindmap.escapeXmlAttribute`) contains a real bug --
 * it does `replace("gt", "&gt;")`, replacing the literal letters "gt" rather
 * than the `>` character, so a title like "gtfo" becomes "&gt;fo". That is not
 * reproduced: it corrupts titles, is plainly unintended, and no client can
 * depend on it. `>` is escaped properly instead.
 */
function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Ports `Mindmap.getDefaultMindmapXml`, byte for byte apart from the fix above. */
export function defaultMindmapXml(title: string, layout = "mindmap"): string {
  return (
    `<map version="tango" theme="prism" layout="${escapeXmlAttribute(layout)}">` +
    `<topic central="true" text="${escapeXmlAttribute(title)}"/></map>`
  );
}
