import "server-only";

import { getQrBaseUrl } from "@/lib/env/app-url";

import {
  buildTableQrUrl,
  classifyBaseUrl,
  qrExportPolicy,
  renderQrSvg,
  type BaseUrlInfo,
  type ExportPolicy,
} from "./qr";

export interface QrContext {
  info: BaseUrlInfo;
  policy: ExportPolicy;
  /** The link a table's QR code carries. */
  urlFor: (code: string) => string;
  /** A data: URI for an <img> preview. Previews are always allowed; test-only ones are marked. */
  previewSrc: (code: string, label: string) => string;
}

/** Everything a page needs to show, preview and (when allowed) export table QR codes. */
export function getQrContext(): QrContext {
  const info = classifyBaseUrl(getQrBaseUrl().origin);
  const policy = qrExportPolicy(info, process.env.NODE_ENV);
  const urlFor = (code: string) => buildTableQrUrl(info.origin, code);
  return {
    info,
    policy,
    urlFor,
    previewSrc: (code, label) =>
      `data:image/svg+xml;utf8,${encodeURIComponent(
        renderQrSvg(urlFor(code), `Table ${label}`, { testOnly: policy.testOnly }),
      )}`,
  };
}
