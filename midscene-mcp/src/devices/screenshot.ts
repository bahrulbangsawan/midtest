import type { Screenshot } from './types.ts';

/**
 * Midscene's `AbstractInterface.screenshotBase64()` returns a *data URI*
 * (`createImgBase64ByFormat` in @midscene/shared builds `data:image/<fmt>;base64,<body>`),
 * not a bare base64 body. MCP image content blocks want the body and the mime type
 * separately, so split them here.
 */
export function uraikanDataUriGambar(dataUri: string): Screenshot {
  const cocok = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(dataUri.trim());
  if (cocok === null) {
    throw new Error(
      `screenshotBase64() did not return a base64 image data URI (got "${dataUri.slice(0, 40)}")`,
    );
  }
  const base64 = cocok[2].trim();
  if (base64 === '') {
    throw new Error('screenshotBase64() returned an empty image body');
  }
  return { mimeType: cocok[1].toLowerCase(), base64 };
}
