import AdmZip from "adm-zip";
import { signNode } from "./adeptSign.ts";
import { parseXml, serializeXml, type XmlNode } from "./adeptXml.ts";
import {
  getAdeptActivation,
  getOperatorState,
  saveOperatorState,
  type AdeptActivation,
} from "./adeptActivation.ts";
import { writeEpub, type ZipEntry } from "./zip.ts";

// Adobe ADEPT fulfilment: an .acsm download token → the encrypted epub it
// stands for. Ported from Leseratte10's acsm-calibre-plugin (libadobeFulfill),
// itself a port of libgourou.
//
// The shape of the exchange:
//   1. (once per operator) POST our credentials to <operator>/Auth, then tell
//      Adobe about it via <activationURL>/InitLicenseService
//   2. POST a SIGNED <adept:fulfill> to <operator>/Fulfill
//   3. the reply carries a download URL and a <licenseToken>
//   4. GET the epub, then inject META-INF/rights.xml built from that token
//
// 🔴 Step 4 is what makes the file decryptable: the downloaded epub is
// encrypted but carries NO rights.xml, so without this injection adept.ts
// would (correctly) refuse it as malformed. The rights.xml also needs the
// licence service's certificate, which is fetched and cached in step 3b.
//
// 🔴 This is the ONE module that talks to the network on a user's behalf, and
// it deliberately does NOT notify the distributor (`do_notify` in the
// reference). Notification only matters for returnable LOANS; these are
// purchases, and a notify failure is a confusing way to lose a book.

const ADEPT_NS = "http://ns.adobe.com/adept";

export type AcsmErrorCode =
  | "not-activated" // no ADOBE_ADEPT_ACTIVATION configured
  | "bad-acsm" // the file isn't a usable fulfilment token
  | "expired" // Adobe/the operator rejected the token
  | "operator-error" // any other error from the far end
  | "network"; // couldn't reach them at all

export class AcsmError extends Error {
  code: AcsmErrorCode;
  constructor(code: AcsmErrorCode, message: string) {
    super(message);
    this.name = "AcsmError";
    this.code = code;
  }
}

function findChild(node: XmlNode, name: string): XmlNode | null {
  return node.children.find((c) => c.name === name && c.ns === ADEPT_NS) ?? null;
}

function findDeep(node: XmlNode, name: string): XmlNode | null {
  if (node.name === name && node.ns === ADEPT_NS) return node;
  for (const c of node.children) {
    const hit = findDeep(c, name);
    if (hit) return hit;
  }
  return null;
}

const AD_PREFIX = new Map([[ADEPT_NS, "adept"]]);

/** Is this an Adobe fulfilment token? */
export function isFulfillmentToken(bytes: Buffer): boolean {
  return /<\s*(?:\w+:)?fulfillmentToken\b/i.test(bytes.subarray(0, 2048).toString("utf8"));
}

async function postDocument(url: string, body: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.adobe.adept+xml" },
      body,
    });
  } catch (err) {
    throw new AcsmError("network", `could not reach ${url}: ${String(err)}`);
  }
  const text = await res.text();
  if (!res.ok && !text.includes("<")) {
    throw new AcsmError("operator-error", `${url} returned HTTP ${res.status}`);
  }
  return text;
}

async function getDocument(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new AcsmError("network", `could not reach ${url}: ${String(err)}`);
  }
  return await res.text();
}

/** Adobe's nonce: 64-bit ms-since-year-0 little-endian + a 32-bit counter. */
function buildNonce(now = Date.now()): string {
  const gregorian = BigInt(now) + 62167219200000n;
  const buf = Buffer.alloc(12);
  buf.writeBigUInt64LE(gregorian, 0);
  buf.writeUInt32LE(0, 8);
  const expires = new Date(now + 10 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    `<adept:nonce>${buf.toString("base64")}</adept:nonce>` +
    `<adept:expiration>${expires}</adept:expiration>`
  );
}

function signedRequest(xml: string, act: AdeptActivation): string {
  const node = parseXml(xml);
  const signature = signNode(node, act.signingKey);
  // Append <adept:signature> to the root, then re-serialise. Building the
  // string by hand (rather than round-tripping the tree) keeps the request
  // bytes identical to what was hashed apart from the appended element.
  const closing = xml.lastIndexOf("</");
  return (
    xml.slice(0, closing) +
    `<adept:signature>${signature}</adept:signature>` +
    xml.slice(closing)
  );
}

/** One-time-per-operator: present our credentials, then register the service. */
async function authenticateToOperator(operatorUrl: string, act: AdeptActivation): Promise<void> {
  const authBase = operatorUrl.endsWith("/Fulfill")
    ? operatorUrl.slice(0, -"/Fulfill".length)
    : operatorUrl;

  const credentials =
    `<?xml version="1.0"?>` +
    `<adept:credentials xmlns:adept="${ADEPT_NS}">` +
    `<adept:user>${act.user}</adept:user>` +
    `<adept:certificate>${act.certificate.toString("base64")}</adept:certificate>` +
    `<adept:licenseCertificate>${act.licenseCertificate}</adept:licenseCertificate>` +
    `<adept:authenticationCertificate>${act.authenticationCertificate}</adept:authenticationCertificate>` +
    `</adept:credentials>`;

  const authReply = await postDocument(`${authBase}/Auth`, credentials);
  if (!authReply.includes("<success")) {
    throw new AcsmError("operator-error", `operator Auth refused: ${authReply.slice(0, 300)}`);
  }

  const initRequest = signedRequest(
    `<?xml version="1.0"?>` +
      `<adept:licenseServiceRequest xmlns:adept="${ADEPT_NS}" identity="user">` +
      `<adept:operatorURL>${authBase}</adept:operatorURL>` +
      buildNonce() +
      `<adept:user>${act.user}</adept:user>` +
      `</adept:licenseServiceRequest>`,
    act,
  );
  const initReply = await postDocument(`${act.activationUrl}/InitLicenseService`, initRequest);
  if (initReply.includes("<error")) {
    throw new AcsmError("operator-error", `InitLicenseService failed: ${initReply.slice(0, 300)}`);
  }
}

/** Cache the licence service's certificate — rights.xml can't be built without it. */
async function ensureLicenseServiceCertificate(
  licenseUrl: string,
  operatorUrl: string,
): Promise<string> {
  const state = getOperatorState();
  const known = state.licenseServices.find((s) => s.licenseURL === licenseUrl);
  if (known) return known.certificate;

  const reply = await getDocument(
    `${operatorUrl}/LicenseServiceInfo?licenseURL=${encodeURIComponent(licenseUrl)}`,
  );
  if (!reply.includes("<licenseServiceInfo")) {
    throw new AcsmError("operator-error", `LicenseServiceInfo failed: ${reply.slice(0, 300)}`);
  }
  const root = parseXml(reply);
  const certificate = findChild(root, "certificate")?.text?.trim();
  const url = findChild(root, "licenseURL")?.text?.trim() ?? licenseUrl;
  if (!certificate) {
    throw new AcsmError("operator-error", "LicenseServiceInfo carried no certificate");
  }
  state.licenseServices.push({ licenseURL: url, certificate });
  saveOperatorState(state);
  return certificate;
}

/** rights.xml: the licence token plus the service info, as adept.ts expects. */
function buildRights(licenseToken: XmlNode, certificate: string): string {
  const licenseUrl = findChild(licenseToken, "licenseURL")?.text?.trim() ?? "";
  return (
    `<?xml version="1.0"?>\n` +
    `<adept:rights xmlns:adept="${ADEPT_NS}">\n` +
    serializeXml(licenseToken, AD_PREFIX) +
    `\n<adept:licenseServiceInfo>\n` +
    `<adept:licenseURL>${licenseUrl}</adept:licenseURL>\n` +
    `<adept:certificate>${certificate}</adept:certificate>\n` +
    `</adept:licenseServiceInfo>\n` +
    `</adept:rights>\n`
  );
}

/** Put rights.xml into the downloaded epub, leaving every other entry alone. */
function injectRights(epub: Buffer, rightsXml: string): Buffer {
  const zip = new AdmZip(epub);
  const entries: ZipEntry[] = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/^\.?\//, "");
    if (name === "mimetype" || name === "META-INF/rights.xml") continue;
    entries.push({ name, data: e.getData() });
  }
  entries.push({ name: "META-INF/rights.xml", data: Buffer.from(rightsXml, "utf8") });
  return writeEpub(entries);
}

/**
 * Fulfil an .acsm into the ENCRYPTED epub it names, with rights.xml injected
 * so `decryptAdept` can then open it. Does not decrypt — `prepareForIngest`
 * chains the two.
 */
export async function fulfillAcsm(acsmBytes: Buffer): Promise<Buffer> {
  const act = getAdeptActivation();
  if (!act) {
    throw new AcsmError(
      "not-activated",
      "no Adobe activation is configured (set ADOBE_ADEPT_ACTIVATION)",
    );
  }

  let acsm: XmlNode;
  try {
    acsm = parseXml(acsmBytes.toString("utf8"));
  } catch {
    throw new AcsmError("bad-acsm", "this .acsm file could not be parsed");
  }
  const operatorUrl = findDeep(acsm, "operatorURL")?.text?.trim();
  if (!operatorUrl) throw new AcsmError("bad-acsm", "this .acsm names no operatorURL");
  const fulfillUrl = `${operatorUrl}/Fulfill`;

  // Authenticate to this operator if we haven't before.
  const state = getOperatorState();
  if (!state.operatorUrls.includes(fulfillUrl)) {
    await authenticateToOperator(fulfillUrl, act);
    state.operatorUrls.push(fulfillUrl);
    saveOperatorState(state);
  }

  const clientVersion = HOBBES_TO_CLIENT[act.hobbesVersion] ?? "3.0.1.91394";
  const request =
    `<?xml version="1.0"?>` +
    `<adept:fulfill xmlns:adept="${ADEPT_NS}">` +
    `<adept:user>${act.user}</adept:user>` +
    `<adept:device>${act.device}</adept:device>` +
    `<adept:deviceType>${act.deviceType}</adept:deviceType>` +
    serializeXml(acsm, AD_PREFIX) +
    `<adept:targetDevice>` +
    `<adept:softwareVersion>${act.hobbesVersion}</adept:softwareVersion>` +
    `<adept:clientOS>${act.clientOS}</adept:clientOS>` +
    `<adept:clientLocale>${act.clientLocale}</adept:clientLocale>` +
    `<adept:clientVersion>${clientVersion}</adept:clientVersion>` +
    `<adept:deviceType>${act.deviceType}</adept:deviceType>` +
    // 🔴 "Digitial" is a real typo in Adobe Digital Editions itself, and the
    // request must reproduce it. Do not correct this spelling.
    `<adept:productName>ADOBE Digitial Editions</adept:productName>` +
    `<adept:fingerprint>${act.fingerprint}</adept:fingerprint>` +
    `<adept:activationToken>` +
    `<adept:user>${act.user}</adept:user>` +
    `<adept:device>${act.device}</adept:device>` +
    `</adept:activationToken>` +
    `</adept:targetDevice>` +
    `</adept:fulfill>`;

  let reply = await postDocument(fulfillUrl, signedRequest(request, act));

  if (reply.includes("<error")) {
    // Some distributors always want a fresh Auth; retry once before giving up.
    if (reply.includes("E_ADEPT_DISTRIBUTOR_AUTH")) {
      await authenticateToOperator(fulfillUrl, act);
      reply = await postDocument(fulfillUrl, signedRequest(request, act));
    }
    if (reply.includes("<error")) {
      const expired =
        /EXPIRED|E_ADEPT_REQUEST_EXPIRED|not found or invalid|E_URLLINK_/i.test(reply);
      throw new AcsmError(
        expired ? "expired" : "operator-error",
        expired
          ? "this .acsm download token has expired — download the book again and upload the fresh file"
          : `fulfilment failed: ${reply.slice(0, 400)}`,
      );
    }
  }

  const replyRoot = parseXml(reply);
  const licenseToken = findDeep(replyRoot, "licenseToken");
  if (!licenseToken) {
    throw new AcsmError("operator-error", "fulfilment reply carried no licenseToken");
  }
  const licenseUrl = findChild(licenseToken, "licenseURL")?.text?.trim();
  if (!licenseUrl) {
    throw new AcsmError("operator-error", "licenseToken carried no licenseURL");
  }
  const downloadUrl = findDeep(replyRoot, "src")?.text?.trim();
  if (!downloadUrl) {
    throw new AcsmError("operator-error", "fulfilment reply carried no download URL");
  }

  const certificate = await ensureLicenseServiceCertificate(licenseUrl, operatorUrl);

  let downloaded: Buffer;
  try {
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      throw new AcsmError("operator-error", `book download returned HTTP ${res.status}`);
    }
    downloaded = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof AcsmError) throw err;
    throw new AcsmError("network", `book download failed: ${String(err)}`);
  }

  if (downloaded.length < 4 || downloaded[0] !== 0x50 || downloaded[1] !== 0x4b) {
    // A PDF (or an error page) rather than an epub.
    throw new AcsmError(
      "operator-error",
      "the fulfilled file is not an epub (PDF titles aren't supported)",
    );
  }

  return injectRights(downloaded, buildRights(licenseToken, certificate));
}

// Hobbes version → the ADE client version string Adobe expects alongside it.
const HOBBES_TO_CLIENT: Record<string, string> = {
  "9.0.1131.27": "ADE WIN 9,0,1131,27",
  "9.3.58046": "2.0.1.78765",
  "10.0.85385": "3.0.1.91394",
  "12.0.123217": "4.0.3.123281",
  "12.5.4.186049": "4.5.10.186048",
  "12.5.4.187298": "4.5.11.187303",
};
