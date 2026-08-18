#!/usr/bin/env python3
"""Add a synthetic fulfil-request case (same STRUCTURE as a real one, fake
identity) hashed by the reference Python and signed with the repo's committed
throwaway key. Run from acsm-plugin/calibre-plugin."""
import base64, json, sys
from lxml import etree

sys.path.insert(0, ".")
from libadobe import hash_node
from customRSA import CustomRSA
from Crypto.PublicKey import RSA

REPO = "/Users/keithadair/Code/keith-hub"
keys = json.load(open(f"{REPO}/books-fixture/adept-test-keys.json"))
signing_key_der = base64.b64decode(keys["right_private_pkcs8_der_b64"])

AD = "http://ns.adobe.com/adept"

# A synthetic ACSM with the same shape Google emits, embedded in a fulfil
# request exactly as buildFulfillRequest does.
acsm = (
    '<fulfillmentToken fulfillmentType="buy" xmlns="http://ns.adobe.com/adept">\n'
    "  <distributor>urn:uuid:00000000-0000-0000-0000-000000000001</distributor>\n"
    "  <operatorURL>http://example.invalid/acs4/fulfillment</operatorURL>\n"
    "  <expiration>2026-01-01T00:00:00-07:00</expiration>\n"
    "  <transaction>ge:11111111-2222-3333-4444-555555555555:1</transaction>\n"
    "  <userId>00000000000000000000</userId>\n"
    "  <resourceItemInfo>\n"
    "    <resource>urn:uuid:11111111-2222-3333-4444-555555555555</resource>\n"
    "    <resourceItem>1</resourceItem>\n"
    '    <src>https://example.invalid/download/Fixture.epub?acsid=urn:uuid:1111&amp;output=acs4_book_bytes</src>\n'
    "    <downloadType>simple</downloadType>\n"
    "  </resourceItemInfo>\n"
    "  <hmac>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</hmac>\n"
    "</fulfillmentToken>\n"
)

request = (
    '<?xml version="1.0"?>'
    '<adept:fulfill xmlns:adept="http://ns.adobe.com/adept">'
    "<adept:user>urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</adept:user>"
    "<adept:device>urn:uuid:99999999-8888-7777-6666-555555555555</adept:device>"
    "<adept:deviceType>standalone</adept:deviceType>"
    + acsm
    + "<adept:targetDevice>"
    "<adept:softwareVersion>10.0.85385</adept:softwareVersion>"
    "<adept:clientOS>Windows 8</adept:clientOS>"
    "<adept:clientLocale>en</adept:clientLocale>"
    "<adept:clientVersion>3.0.1.91394</adept:clientVersion>"
    "<adept:deviceType>standalone</adept:deviceType>"
    "<adept:productName>ADOBE Digitial Editions</adept:productName>"
    "<adept:fingerprint>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</adept:fingerprint>"
    "<adept:activationToken>"
    "<adept:user>urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</adept:user>"
    "<adept:device>urn:uuid:99999999-8888-7777-6666-555555555555</adept:device>"
    "</adept:activationToken>"
    "</adept:targetDevice>"
    "</adept:fulfill>"
)

node = etree.fromstring(request.encode("utf-8"))
sha1 = hash_node(node).digest()
sig = base64.b64encode(
    CustomRSA.encrypt_for_adobe_signature(signing_key_der, sha1)
).decode()

path = f"{REPO}/books-fixture/adept-hash-cases.json"
doc = json.load(open(path))
doc["cases"]["synthetic_fulfill_request"] = {
    "xml": request,
    "sha1": sha1.hex(),
    "signature_b64": sig,
    "note": "Same structure as a real Google fulfil request (embedded ACSM, "
            "targetDevice block, the genuine 'Digitial' typo), with fabricated "
            "identity. Signed with books-fixture/adept-test-keys.json.",
}
json.dump(doc, open(path, "w"), indent=2)
print("added synthetic_fulfill_request")
print("  sha1:", sha1.hex())
print("  sig :", sig[:44], "...")
