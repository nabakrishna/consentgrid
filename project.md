# ConsentGrid — Project Documentation

## 1. Purpose

ConsentGrid exists to solve one specific, legally urgent problem: **Indian businesses currently cannot prove they obtained valid consent to use someone's personal data, under the standard the law now requires.**

India's Digital Personal Data Protection (DPDP) Act, 2023, backed by the DPDP Rules, 2025, makes consent legally invalid unless it is:
- Given in a language the person actually understands (English or any of the 22 Eighth Schedule languages)
- The result of a clear, affirmative action — not a pre-ticked box or implied agreement
- Specific to a stated purpose, not a blanket "I agree to everything"
- Revocable, with downstream systems expected to honor withdrawal

Failing to meet this standard exposes a business to penalties of up to ₹250 crore (~$30M USD) per violation. Most businesses today are using generic, Western-style cookie banners that do not meet any of these requirements — they have no way to prove, after the fact, what a specific user actually saw and agreed to.

**ConsentGrid's purpose is to be that proof.** It is not a marketing consent tool or a cookie-banner replacement — it is a compliance-grade evidentiary system: every time a user consents, ConsentGrid produces a cryptographically signed, tamper-evident record (a "Consent Artifact") proving exactly what notice was shown, in what language, and what the user agreed to — durable enough to survive a regulator's audit or a court challenge.

---

## 2. About the Project

### What it is
A multi-tenant SaaS platform, delivered as an embeddable widget plus an API, that a business ("Data Fiduciary" in DPDP terminology) integrates into their website or app to handle consent capture, storage, and lifecycle management.

### What it is not
- Not a general-purpose cookie-consent banner
- Not a GDPR tool repurposed for India (the language and purpose-binding requirements are meaningfully different)
- Not, at this stage, a full "Consent Manager" in the DPDP Act's formal regulatory sense — that requires official registration with India's Data Protection Board, which is a separate, later undertaking (see Roadmap)

### Who it's for
- Primary: Indian D2C e-commerce, fintech apps, and SaaS products with real DPDP exposure and no in-house compliance engineering
- Go-to-market wedge: digital agencies and Shopify developers who serve many small Indian merchants and can integrate the widget once, then resell/deploy it across clients

### The core mechanism
1. A user visits a business's website. The widget detects the most likely language they understand (from the page's own language, a stored preference, or the browser) and asks them to confirm it — never guesses silently.
2. The user is shown a notice in that confirmed language, with individually toggle-able purposes (marketing, analytics, etc.) — nothing pre-checked.
3. On submission, the platform mints a **Consent Artifact**: a signed record containing what was shown, in what language, what was agreed to, and when — chained cryptographically to every prior record so none can be altered after the fact.
4. If the user later withdraws consent, a webhook notifies the business's own systems (CRM, email tool, ad platform) to act on it.
5. Anyone — an auditor, the user themselves, the business — can independently verify any artifact's authenticity via a public verification endpoint, without exposing personal data.

---

## 3. Problem Statement

| Who | Problem |
|---|---|
| Indian businesses | Facing existential fines under DPDP but have no compliant way to capture consent; existing tools are built for a different legal regime (GDPR) |
| End users (Data Principals) | Frequently asked to "consent" in a language or format they don't understand, with no real way to know what they agreed to or revoke it |
| Regulators (DPB) | Need infrastructure to actually audit consent claims at scale, across millions of small businesses, once enforcement begins (May 2027) |

---

## 4. Solution Architecture

### Core components
1. **Consent notice + capture widget** — embeddable JS SDK, under 15KB gzipped, language-aware, fails safe (queues locally via IndexedDB/WebCrypto if the API is briefly unreachable, rather than blocking the host site)
2. **Consent Artifact service** — the cryptographic core: HMAC-SHA256 keyed identifier hashing, KMS-backed digital signatures, hash-chained storage for tamper evidence
3. **Webhook/propagation engine** — standardized, signed webhook payloads notifying downstream systems of grants/withdrawals, with retry and dead-letter handling for failed deliveries
4. **Multi-tenant admin dashboard** — where a business manages notice templates, approves translations, views its consent log, and exports audit data
5. **Public verification endpoint** — lets anyone independently confirm an artifact's authenticity without needing an account or exposing personal data

### Key design decisions and why they matter
- **Language resolution is efficient, not exhaustive.** The system doesn't pre-translate or render all 22 languages for every visitor — it narrows to 3-4 likely candidates (prioritizing the host page's own declared language) and only fetches/caches the one actually confirmed.
- **Identity is tokenized, not stored.** The platform never holds a user's raw email or phone number — only an opaque token the business already controls, plus a keyed hash for internal matching. A database breach yields nothing personally identifying.
- **Erasure works via crypto-shredding.** Deleting a per-user cryptographic salt makes a historical record permanently unlinkable to a person, without destroying the audit chain itself — resolving the tension between the law's erasure right and the law's audit-retention requirement.
- **Every legally load-bearing design decision is flagged, not assumed.** A dedicated `LEGAL-OPEN-QUESTIONS.md` tracks every point where engineering made a defensible technical choice that still requires actual legal sign-off before production use.

### Explicit scope boundary (MVP)
The platform generates and signs the proof of consent; it does **not**, at this stage, reach into a business's CRM/email/ad systems to execute deletions itself. It notifies via webhook; the business's own systems act on it. (A stronger, enterprise-grade alternative — a customer-hosted "Privacy Sidecar" that executes deletions without ever sharing database credentials — exists as a documented future option, not built.)

---

## 5. Technology Stack (as implemented)

- **Backend**: Node.js, standard library only for the core (no framework dependency for crypto/business logic), Fastify-style routing
- **Database**: PostgreSQL for production; a SQLite-compatible adapter for zero-dependency local development, sharing identical query logic across both
- **Cryptography**: `node:crypto` for HMAC/ECDSA; a pluggable KMS interface with a local dev signer and an AWS KMS-backed production signer
- **Widget**: vanilla JavaScript, no framework, to keep the embed lightweight on client sites
- **Testing**: `node:test`, with a coverage gate enforced specifically on the cryptographic and hash-chain code paths
- **Docs**: OpenAPI 3.1 spec, JSON Schema for the artifact format

---

## 6. Security Posture (summary — see SECURITY.md for full detail)

- Zero-PII identity model: opaque tokens only, never raw contact information
- Signing keys live exclusively in a KMS/HSM, never in application code or config
- Role-based internal access control with audit-logged access to raw consent data
- Database-level enforcement (not just application logic) of append-only records and immutable notice versioning
- Rate limiting and bot-detection on the public consent endpoint to prevent fabricated consent records

---

## 7. Compliance & Legal Approach

ConsentGrid treats legal correctness as a first-class engineering constraint, not an afterthought:
- Every implementation decision touching a genuinely unsettled point of DPDP interpretation is documented in `LEGAL-OPEN-QUESTIONS.md` and explicitly flagged as requiring counsel sign-off, not resolved by engineering judgment alone
- Three open questions currently tracked: whether crypto-shredding satisfies the legal definition of "erasure," whether the guardian-verification liability boundary is sufficient for minor consent at MVP stage, and whether two-step language confirmation satisfies the "affirmative action" and comprehension standard

---

## 8. Business Model & Go-to-Market

- **Wedge**: a "DPDP-Ready Consent Widget" sold through agencies and Shopify developers serving Indian merchants, priced to be trivially cheaper than the risk of a ₹250Cr fine
- **Moat**: primarily regulatory positioning (becoming a Data Protection Board-registered Consent Manager) plus network effects (the more fiduciaries integrate, the more valuable the platform becomes as a trust hub) — not defensible on code alone, which is why the core backend should not be open-sourced (see licensing discussion)
- **Expansion paths considered, explicitly deferred**: Account Aggregator/RBI schema alignment to serve banking/fintech (a distinct regulatory regime, requires separate legal review before pursuing)

---

## 9. Roadmap / Tiering

| Tier | Contents | When to build |
|---|---|---|
| **MVP (built)** | Core widget, artifact signing, webhook + DLQ, dashboard, minor-consent flow with documented liability boundary, crypto-shredding erasure | Now |
| **Tier 2 — Growth / Registered Consent Manager** | Merkle tree anchoring for stronger tamper-proofing, DigiLocker/Aadhaar KUA integration replacing OTP-only minor consent, CRDT-backed offline queue, edge compute for language resolution | Once pursuing official DPB registration and real customer volume |
| **Tier 3 — Enterprise/Regulated** | Confidential computing enclaves, customer-hosted "Privacy Sidecar" for zero-integration deletion, Account Aggregator/RBI schema parity | Only if a specific enterprise or regulated-sector customer requires it |

---

## 10. Current Status

- Core backend, crypto engine, webhook system, admin dashboard, and embeddable widget are built and running
- 43/43 automated tests passing, including dedicated coverage on the cryptographic and hash-chain paths
- Widget confirmed under its 15KB size budget
- `SECURITY.md`, `LEGAL-OPEN-QUESTIONS.md`, `COST-MODEL.md`, and a verified how-to-run README exist as real project documents
- Manually verified end-to-end: seeding a demo org, logging into the dashboard, running the widget, and independently verifying a resulting artifact

## 11. What Has Not Yet Happened (honest gaps)

- No real legal counsel review of the three open legal questions — everything so far is engineering's best defensible interpretation, not a legal conclusion
- No real customer, agency, or merchant has used or seen this
- No official DPB Consent Manager registration process has been started
- No production deployment, security penetration test, or real infrastructure spend has occurred
- Translations exist only as placeholders for demo purposes (EN/HI/etc.) — not yet professionally, legally reviewed translations for all needed languages

---

## 12. Suggested Next Steps, in Priority Order

1. Get the `LEGAL-OPEN-QUESTIONS.md` items in front of an actual DPDP-focused lawyer
2. Show the working MVP to 3-5 real Indian small-business owners or agencies and gauge actual willingness to pay — this is more valuable right now than further feature-building
3. Only after real interest is confirmed: pursue professional translation review, real infrastructure deployment, and a formal security review