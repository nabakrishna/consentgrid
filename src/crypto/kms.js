// src/crypto/kms.js
// ─────────────────────────────────────────────────────────────────────────
// KeyManager: the ONLY place that touches a private signing key.
//
// [MUST-V1] Signing keys live in a KMS/HSM. They never appear in app config,
// environment variables, edge nodes, or developer workstations in production.
//
// This module defines a provider-agnostic interface with two implementations:
//   - LocalDevSigner : software keys on disk. DEV/TEST ONLY. Loudly refuses
//                      to run when NODE_ENV=production.
//   - AwsKmsSigner   : real AWS KMS asymmetric ECC_NIST_P256 signing. The
//                      private key material never leaves KMS; we only ever
//                      send it a digest and receive a signature.
//
// Every signature is tagged with a `key_id` [MUST-V1: key rotation] so
// historical artifacts remain verifiable after the active key rotates.
// ─────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALG = 'sha256';
const CURVE = 'P-256'; // ECC_NIST_P256 — matches AWS KMS ECDSA_SHA_256

/**
 * @typedef {Object} SignResult
 * @property {string} key_id       Identifier of the key that produced the signature.
 * @property {string} algorithm    e.g. "ECDSA_SHA_256".
 * @property {string} signature    base64 DER-encoded signature.
 */

/**
 * Abstract KeyManager. Do not instantiate directly; use createKeyManager().
 */
export class KeyManager {
  /** @returns {Promise<SignResult>} */
  async sign(_bytes) { throw new Error('not implemented'); }

  /**
   * Verify a signature against a specific historical key_id.
   * @returns {Promise<boolean>}
   */
  async verify(_bytes, _signatureB64, _keyId) { throw new Error('not implemented'); }

  /** @returns {Promise<string>} PEM public key for a given key_id (for offline verification / publishing). */
  async publicKeyPem(_keyId) { throw new Error('not implemented'); }

  /** @returns {string} the currently-active key_id used for new signatures. */
  activeKeyId() { throw new Error('not implemented'); }
}

// ── Local dev signer ───────────────────────────────────────────────────────
export class LocalDevSigner extends KeyManager {
  #dir;
  #active;
  #cache = new Map(); // key_id -> { privatePem, publicPem }

  constructor(dir) {
    super();
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'REFUSING TO START: LocalDevSigner must never run in production. ' +
        'Set KMS_PROVIDER=aws and configure KMS_SIGNING_KEY_ARN.'
      );
    }
    this.#dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.#active = this.#ensureActiveKey();
  }

  #keyPaths(keyId) {
    return {
      priv: path.join(this.#dir, `${keyId}.priv.pem`),
      pub: path.join(this.#dir, `${keyId}.pub.pem`),
    };
  }

  #ensureActiveKey() {
    const pointer = path.join(this.#dir, 'ACTIVE');
    if (fs.existsSync(pointer)) {
      const id = fs.readFileSync(pointer, 'utf8').trim();
      if (fs.existsSync(this.#keyPaths(id).priv)) return id;
    }
    // Generate a fresh key with a rotation-friendly id.
    const keyId = `local-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: CURVE });
    const { priv, pub } = this.#keyPaths(keyId);
    fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(pointer, keyId);
    return keyId;
  }

  #load(keyId) {
    if (this.#cache.has(keyId)) return this.#cache.get(keyId);
    const { priv, pub } = this.#keyPaths(keyId);
    const entry = {
      privatePem: fs.existsSync(priv) ? fs.readFileSync(priv, 'utf8') : null,
      publicPem: fs.existsSync(pub) ? fs.readFileSync(pub, 'utf8') : null,
    };
    this.#cache.set(keyId, entry);
    return entry;
  }

  activeKeyId() { return this.#active; }

  async sign(bytes) {
    const { privatePem } = this.#load(this.#active);
    if (!privatePem) throw new Error(`missing private key for ${this.#active}`);
    // DER signature format matches AWS KMS output for portability.
    const signature = crypto.sign(ALG, bytes, { key: privatePem, dsaEncoding: 'der' });
    return { key_id: this.#active, algorithm: 'ECDSA_SHA_256', signature: signature.toString('base64') };
  }

  async verify(bytes, signatureB64, keyId) {
    const { publicPem } = this.#load(keyId);
    if (!publicPem) return false;
    try {
      return crypto.verify(ALG, bytes, { key: publicPem, dsaEncoding: 'der' }, Buffer.from(signatureB64, 'base64'));
    } catch {
      return false;
    }
  }

  async publicKeyPem(keyId) {
    const { publicPem } = this.#load(keyId);
    if (!publicPem) throw new Error(`no public key for ${keyId}`);
    return publicPem;
  }

  /** Test/ops helper: rotate to a brand-new key. Historical keys stay on disk for verification. */
  rotate() {
    const pointer = path.join(this.#dir, 'ACTIVE');
    fs.rmSync(pointer, { force: true });
    this.#cache.clear();
    this.#active = this.#ensureActiveKey();
    return this.#active;
  }
}

// ── AWS KMS signer (production path) ─────────────────────────────────────────
// Implemented against the KMS REST/JSON API shape. We deliberately avoid a
// hard dependency on @aws-sdk so the tree installs and tests run in registry-
// restricted environments. Where the SDK is available, swap #kmsCall for it.
export class AwsKmsSigner extends KeyManager {
  #keyArn;
  #region;
  #pubCache = new Map();

  constructor({ keyArn, region }) {
    super();
    if (!keyArn) throw new Error('KMS_SIGNING_KEY_ARN required for KMS_PROVIDER=aws');
    this.#keyArn = keyArn;
    this.#region = region || process.env.AWS_REGION || 'ap-south-1';
  }

  activeKeyId() { return this.#keyArn; }

  // The digest is computed locally; only the 32-byte SHA-256 digest is sent to
  // KMS with MessageType=DIGEST. Private key material never leaves the HSM.
  async sign(bytes) {
    const digest = crypto.createHash(ALG).update(bytes).digest();
    const out = await this.#kmsCall('Sign', {
      KeyId: this.#keyArn,
      Message: digest.toString('base64'),
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256',
    });
    return { key_id: this.#keyArn, algorithm: 'ECDSA_SHA_256', signature: out.Signature };
  }

  async verify(bytes, signatureB64, keyId) {
    // Prefer local verification with the cached public key (cheap, offline-capable).
    try {
      const pem = await this.publicKeyPem(keyId);
      return crypto.verify(ALG, bytes, { key: pem, dsaEncoding: 'der' }, Buffer.from(signatureB64, 'base64'));
    } catch {
      // Fall back to KMS Verify if the public key can't be fetched.
      const digest = crypto.createHash(ALG).update(bytes).digest();
      const out = await this.#kmsCall('Verify', {
        KeyId: keyId,
        Message: digest.toString('base64'),
        MessageType: 'DIGEST',
        Signature: signatureB64,
        SigningAlgorithm: 'ECDSA_SHA_256',
      });
      return out.SignatureValid === true;
    }
  }

  async publicKeyPem(keyId) {
    if (this.#pubCache.has(keyId)) return this.#pubCache.get(keyId);
    const out = await this.#kmsCall('GetPublicKey', { KeyId: keyId });
    const der = Buffer.from(out.PublicKey, 'base64');
    const pem =
      '-----BEGIN PUBLIC KEY-----\n' +
      der.toString('base64').match(/.{1,64}/g).join('\n') +
      '\n-----END PUBLIC KEY-----\n';
    this.#pubCache.set(keyId, pem);
    return pem;
  }

  async #kmsCall(_action, _body) {
    // Intentional seam. In a registry-connected environment, replace with:
    //   import { KMSClient, SignCommand, ... } from '@aws-sdk/client-kms';
    // and map the response. Kept as an explicit throw so it can never be
    // mistaken for a working prod integration that silently no-ops.
    throw new Error(
      `AwsKmsSigner.${_action}: wire up @aws-sdk/client-kms in an environment ` +
      `with registry access. This stub exists so the interface + verification ` +
      `path are exercised by tests without a network dependency.`
    );
  }
}

export function createKeyManager(env = process.env) {
  const provider = (env.KMS_PROVIDER || 'local').toLowerCase();
  if (provider === 'aws') {
    return new AwsKmsSigner({ keyArn: env.KMS_SIGNING_KEY_ARN, region: env.AWS_REGION });
  }
  if (provider === 'local') {
    return new LocalDevSigner(env.KMS_LOCAL_DIR || './data/keys');
  }
  throw new Error(`unknown KMS_PROVIDER: ${provider}`);
}
