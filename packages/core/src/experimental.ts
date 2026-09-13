/**
 * @zbase-protocol/core/experimental — UNFINISHED UTXO surface. NOT PRODUCTION.
 *
 * ⚠️⚠️ DO NOT USE WITH REAL FUNDS. These variable-amount UTXO primitives are a
 * PRE-DEPLOYMENT scaffold. The UTXO pool is not deployed (routes return 501) and
 * the trusted-setup ceremony has not run. The 2026-07-09 SDK + black-hat audits
 * confirmed integrator FUND-LOSS footguns here, still present by design until the
 * post-ceremony rewrite:
 *   - WIRE-FORMAT BREAK (HIGH): encryptNoteForTransfer produces a ~330-byte
 *     length-prefixed envelope (packCiphertext), but the scanner's
 *     decodeTransferredLog reassembles a FIXED 128-byte bytes32[4] blob →
 *     decryption returns null → a recipient CANNOT see or spend their own inbound
 *     note. Building a wallet on createScanner today will LOSE received funds.
 *   - createNote defaults NPK material to 0 → a note addressable to nobody;
 *   - deserializeNote now range-validates (fixed), but malformed notes throw;
 *   - deriveViewingKeyFromSeed now requires the exact 64-byte BIP39 seed (fixed).
 *
 * The wire-format break is NOT fixed here (it needs the frozen post-ceremony
 * schema); it is quarantined behind this subpath so no main-entry integrator hits
 * it. If you import this, you accept these are unfinished and fund-unsafe.
 *
 * This surface lives on a SEPARATE subpath (not the main entry) so no integrator
 * reaches it by accident: you must explicitly `import ... from
 * "@zbase-protocol/core/experimental"` and thereby accept it is unfinished. Do
 * NOT rely on the UTXO wire format or these APIs against real funds until the
 * pool + ceremony land and these are re-audited.
 */

export type { Note, ViewingKeyPair, EncryptedNote } from "./notes.js";
export {
  createNote,
  createDummyNote,
  commitmentOf,
  npkOf,
  nullifierHashOf,
  splitNote,
  mergeNotes,
  planSpend,
  consolidateNotes,
  serializeNote,
  deserializeNote,
  generateViewingKey,
  encryptNote,
  decryptNote,
  scanNotes,
  NoteValueError,
  commitmentAAD,
  encryptNoteForTransfer,
  decryptNoteWithAAD,
  packCiphertext,
  unpackCiphertext,
  CIPHERTEXT_WIRE_VERSION,
} from "./notes.js";
export type { DerivedNPK, DeriveRecipientNPKParams } from "./npk.js";
export { deriveRecipientNPK, recoverViewingPKBlind, bytesToField } from "./npk.js";
export type { ViewingKey } from "./viewingKeyHD.js";
export {
  ZBASE_VIEWING_KEY_PATH_PREFIX,
  DEFAULT_MNEMONIC_STRENGTH_BITS,
  generateNewMnemonic,
  deriveViewingKeyFromMnemonic,
  deriveViewingKeyFromSeed,
  exportMnemonic,
  mnemonicFromEntropy,
  isValidMnemonic,
} from "./viewingKeyHD.js";
export type {
  ScannerEvent,
  ScannerConnectedEvent,
  ScannerSpentEvent,
  ScannerTransferredInEvent,
  ScannerTransferredOtherEvent,
  ScannerErrorEvent,
  ScannerOptions,
  DecodedTransferredLog,
} from "./noteScanner.js";
export {
  createScanner,
  decodeSpentLog,
  decodeTransferredLog,
  tryDecryptTransferred,
  scanTransferredLogs,
  SPENT_TOPIC,
  TRANSFERRED_TOPIC,
} from "./noteScanner.js";
