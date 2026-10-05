import Foundation
import Security
import CryptoKit

// Remote-control device key helper.
//
// The ChatGPT remote-control service hands out a challenge and expects a public
// key plus a signature over a canonical payload. The key lives in the login
// keychain and is not extractable, which is what the service's
// "allow_os_protected_nonextractable" protection class names.
//
//   proof <label> <paramsBase64>
//      paramsBase64 is JSON with: nonce, challengeId, targetOrigin, targetPath,
//      accountUserId, clientId, challengeExpiresAt
//      Creates a fresh key, builds the payload, signs it, prints one JSON object:
//      {keyId, publicKeySpkiDerBase64, algorithm, protectionClass,
//       signatureDerBase64, signedPayloadBase64}
//
// Creating and signing happen in this one process on purpose: a keychain key
// used from a different process than the one that created it raises the macOS
// "wants to use your keychain" prompt, which blocks silently when nobody is
// watching the screen.

let algorithm = "ecdsa_p256_sha256"
// The service's enum is hardware_secure_enclave | hardware_tpm |
// os_protected_nonextractable. "allow_os_protected_nonextractable" is the
// reference client's internal name for it and is rejected on the wire.
let protectionClass = "os_protected_nonextractable"
let spkiHeader = Data([0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00])

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func jsonString(_ value: String) -> String {
  let escaped = value
    .replacingOccurrences(of: "\\", with: "\\\\")
    .replacingOccurrences(of: "\"", with: "\\\"")
  return "\"" + escaped + "\""
}

let args = CommandLine.arguments
guard args.count >= 4, args[1] == "proof" else {
  fail("usage: proof <label> <paramsBase64>")
}
let label = args[2]
guard let paramsData = Data(base64Encoded: args[3]),
      let params = try? JSONSerialization.jsonObject(with: paramsData) as? [String: Any] else {
  fail("params are not base64 JSON")
}
func param(_ key: String) -> String {
  if let value = params[key] as? String { return value }
  if let value = params[key] as? Int { return String(value) }
  if let value = params[key] as? Double { return String(Int(value)) }
  fail("missing param: " + key)
}
let expiresAt = Int(param("challengeExpiresAt")) ?? 0

// A fresh key per enrolment. The old one is replaced so a retried pairing does
// not leave stale keychain items behind.
SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrLabel as String: label] as CFDictionary)
var error: Unmanaged<CFError>?
let attributes: [String: Any] = [
  kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
  kSecAttrKeySizeInBits as String: 256,
  kSecAttrIsPermanent as String: true,
  kSecAttrLabel as String: label,
  kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
  kSecPrivateKeyAttrs as String: [
    kSecAttrIsPermanent as String: true,
    kSecAttrLabel as String: label,
    kSecAttrIsExtractable as String: false,
    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
  ],
]
guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
  fail("create failed: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
}
guard let publicKey = SecKeyCopyPublicKey(privateKey),
      let raw = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
  fail("public key export failed")
}
let spkiBase64 = (spkiHeader + raw).base64EncodedString()

let identityHash = Data(SHA256.hash(data: Data(
  "{\"algorithm\":\"\(algorithm)\",\"keyId\":\"\(label)\",\"protectionClass\":\"\(protectionClass)\",\"publicKeySpkiDerBase64\":\"\(spkiBase64)\"}".utf8
))).base64EncodedString()
  .replacingOccurrences(of: "+", with: "-")
  .replacingOccurrences(of: "/", with: "_")
  .replacingOccurrences(of: "=", with: "")

// Exactly the bytes the service expects signed: a domain wrapper around the
// payload, with the payload's keys in alphabetical order. Signing a flat object
// with any other arrangement produces a signature the server cannot verify, and
// it reports that as a generic reauthentication failure rather than a bad proof.
let payload = "{"
  + "\"domain\":\"codex-device-key-sign-payload/v1\","
  + "\"payload\":{"
  + "\"accountUserId\":" + jsonString(param("accountUserId")) + ","
  + "\"audience\":\"remote_control_client_enrollment\","
  + "\"challengeExpiresAt\":" + String(expiresAt) + ","
  + "\"challengeId\":" + jsonString(param("challengeId")) + ","
  + "\"clientId\":" + jsonString(param("clientId")) + ","
  + "\"deviceIdentitySha256Base64url\":" + jsonString(identityHash) + ","
  + "\"nonce\":" + jsonString(param("nonce")) + ","
  + "\"targetOrigin\":" + jsonString(param("targetOrigin")) + ","
  + "\"targetPath\":" + jsonString(param("targetPath")) + ","
  + "\"type\":\"remoteControlClientEnrollment\""
  + "}}"

guard let signature = SecKeyCreateSignature(
  privateKey,
  .ecdsaSignatureMessageX962SHA256,
  Data(payload.utf8) as CFData,
  &error
) as Data? else {
  fail("sign failed: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
}

print("{"
  + "\"keyId\":\"\(label)\","
  + "\"publicKeySpkiDerBase64\":\"\(spkiBase64)\","
  + "\"algorithm\":\"\(algorithm)\","
  + "\"protectionClass\":\"\(protectionClass)\","
  + "\"signatureDerBase64\":\"\(signature.base64EncodedString())\","
  + "\"signedPayloadBase64\":\"\(Data(payload.utf8).base64EncodedString())\""
  + "}")
