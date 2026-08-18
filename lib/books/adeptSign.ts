import { constants, createHash, createPrivateKey, privateDecrypt } from "crypto";
import { canonicalBytes, parseXml, type XmlNode } from "./adeptXml.ts";

// Signing an ADEPT request.
//
// SHA-1 over Adobe's canonical serialisation (adeptXml.ts), then "textbook" RSA
// over a PKCS#1-v1.5-shaped block — but NOT a standard RSA signature:
//
//   block = 00 01 FF…FF 00 <sha1>
//
// 🔴 There is deliberately NO DigestInfo ASN.1 prefix. A normal
// RSASSA-PKCS1-v1.5 signature (what `crypto.sign("sha1", …)` produces) wraps
// the digest in a DigestInfo header, and Adobe's verifier does not expect one —
// so `crypto.sign` CANNOT be used here and its output would be rejected.
// Instead the padded block is put through the raw private-key operation
// (m^d mod n) via privateDecrypt + RSA_NO_PADDING, which is exactly what the
// reference implementation's CustomRSA.encrypt_for_adobe_signature does.

/** SHA-1 of a node's canonical serialisation. */
export function hashNode(node: XmlNode): Buffer {
  return createHash("sha1").update(canonicalBytes(node)).digest();
}

function modulusSize(keyDer: Buffer): number {
  const key = createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
  // asymmetricKeyDetails.modulusLength is in bits.
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (!bits) throw new Error("adept sign: could not determine RSA modulus size");
  return bits / 8;
}

/** 00 01 FF…FF 00 <message>, padded to the modulus size. */
function padForAdobe(message: Buffer, targetLen: number): Buffer {
  const maxLen = targetLen - 11;
  if (message.length > maxLen) {
    throw new Error(`adept sign: message ${message.length} bytes exceeds ${maxLen}`);
  }
  const padLen = targetLen - message.length - 3;
  return Buffer.concat([
    Buffer.from([0x00, 0x01]),
    Buffer.alloc(padLen, 0xff),
    Buffer.from([0x00]),
    message,
  ]);
}

/**
 * Sign a node with the activation's signing key.
 * @param signingKeyDer RSA private key, PKCS#8 DER (from the activation pkcs12).
 * @returns base64 signature, ready for <adept:signature>.
 */
export function signNode(node: XmlNode, signingKeyDer: Buffer): string {
  const digest = hashNode(node);
  const size = modulusSize(signingKeyDer);
  const block = padForAdobe(digest, size);
  const key = createPrivateKey({ key: signingKeyDer, format: "der", type: "pkcs8" });
  // Raw private-key operation. privateDecrypt with NO_PADDING computes
  // block^d mod n and returns the full modulus-sized result.
  const signed = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, block);
  return signed.toString("base64");
}

/** Convenience: parse then sign, for callers holding a request string. */
export function signXmlString(xml: string, signingKeyDer: Buffer): string {
  return signNode(parseXml(xml), signingKeyDer);
}
