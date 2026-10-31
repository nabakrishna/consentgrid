# LEGAL-OPEN-QUESTIONS.md

**Purpose**: this document tracks specific technical architectures, as actually implemented in this codebase, that require explicit sign-off from external legal counsel regarding their interpretation of the DPDP Act, 2023 and DPDP Rules, 2025. Engineering has not treated any of these as legally settled — each is implemented defensively, but the underlying legal question remains open.

---

## 1. The Erasure vs. Auditability Paradox (Crypto-Shredding)

**The DPDP Tension**: Section 12 provides for correction and erasure of personal data. A registered Consent Manager must also retain audit-grade logs to demonstrate compliance to the Data Protection Board (DPB).

**Implementation** (`src/crypto/identity.js`, `ConsentService.erase()` in `src/api/consent-service.js`): the stored identifier is `id_hash = HMAC-SHA256(perUserSalt || SERVER_HMAC_PEPPER, user_token)`. The per-user salt is held by the Data Fiduciary. On a valid erasure request, the platform first mints a terminal ERASE artifact into the ledger (so the erasure event itself is auditable), then instructs destruction of the salt. Once the salt is gone, `identifierHash()` throws and `identifierMatches()` returns `false` — the historical `id_hash` values remain in the ledger, and the hash-chain stays structurally intact, but recomputing or matching the original identifier becomes mathematically impossible.

**Disclosed dependency (do not omit when presenting this to counsel)**: the platform does not control salt destruction — it happens on the Fiduciary's side. The platform can log that an erasure instruction was issued, but cannot independently verify that a Fiduciary actually destroyed their copy of the salt.

**Question for Counsel**: Does crypto-shredding a per-user salt satisfy the DPDP definition of "erasure"? Does the disclosed dependency on Fiduciary-side salt destruction (rather than platform-controlled deletion) shift or share liability between the Consent Manager and the Data Fiduciary in a way that needs to be made explicit in the customer contract?

---

## 2. Minor Consent & Guardian Verification Liability Boundary

**The DPDP Tension**: Section 9 requires verifiable consent from a lawful guardian for Data Principals under 18.

**Implementation** (`src/api/guardian-service.js`): the platform runs an OTP flow to a guardian-declared phone number, storing only a hash of the declared phone (`guardian_ref_hash`) and a hash of the OTP — never the raw phone number or OTP. The module's own header comment states the boundary explicitly: *"The platform has NO governmental authority to verify that a phone number belongs to an actual legal guardian. This flow proves only that an OTP sent to a guardian-declared number was entered back correctly."* Every minted artifact for a minor carries a `guardian_verification` block with `liability_note: 'flow-executed-not-identity-verified'` (`src/api/consent-service.js`) — the liability boundary is embedded in the data model itself, not just documentation.

**Question for Counsel**: Is this contractual/technical liability boundary (platform proves the flow executed and logged; Data Fiduciary retains liability for the truth of the guardianship claim) sufficient for MVP operation under the DPDP Rules? Should the `liability_note` or an equivalent disclosure be surfaced to the Data Principal (or their guardian) directly at consent time, not only retained internally? Is the planned Tier-2 upgrade to DigiLocker/Aadhaar KUA integration (storing only a government-issued cryptographic transaction receipt) a firm precondition for handling minors at any meaningful volume, or is the MVP boundary acceptable on an interim basis?

---

## 3. Affirmative Action in Language Selection

**The DPDP Tension**: consent must be given in a language the Data Principal actually understands (Eighth Schedule languages); consent obtained in a language the user does not comprehend is not valid consent.

**Implementation** (`assertLanguageConfirmed()` in `src/api/consent-service.js`): the widget suggests a candidate language (prioritizing the host page's `<html lang>` attribute, then stored preference, then browser locale) but never auto-selects. The server enforces this independently — it rejects (HTTP 422) any GRANT/CORRECT submission lacking an explicit `language_confirmed` interaction event tied to the resolved locale. Additionally, `getApprovedLocale()` blocks minting entirely (HTTP 409, `no_approved_notice`) if the resolved locale has no legally-approved notice — there is no silent fallback to English anywhere in the code path.

**Question for Counsel**: Does this two-step flow (explicit language confirmation → then consent capture, both independently enforced server-side) satisfy the Act's "affirmative action" and comprehension requirements? Is an explicit language-confirmation interaction legally sufficient evidence of comprehension, or does it only evidence language *selection* — and if the latter, is there a lower-cost mechanism (short of testing comprehension) that counsel would consider adequate?

---

## 4. Standardized Webhook Revocation Payload — Data Processing Instruction, Not Just Notification

**Not yet flagged in the original spec, surfaced during implementation.** The webhook payload emitted on withdrawal/erasure (`src/api/consent-service.js`, `enqueueFor`) is a standardized, machine-actionable instruction — e.g. `{"action": "REVOKE", "purpose_id": "marketing", "user_token": ...}` — that a receiving Fiduciary's middleware is expected to act on directly (per-purpose GRANT/REVOKE/WITHDRAW/ERASE). This is stronger than a passive "FYI, something changed" notification.

**Question for Counsel**: Does issuing a standardized, actionable revocation directive (rather than a purely informational event) create any additional obligation or liability for ConsentGrid if a receiving Fiduciary's middleware fails to act on it correctly? Should the webhook contract or terms of service explicitly disclaim responsibility for downstream execution while still asserting the instruction itself is standardized and unambiguous?

---
## 5. AA/RBI Schema Parity — Strategic, Not Yet a Legal Question

Not an open legal question requiring sign-off today, but flagged for awareness: if the business pursues Account Aggregator/RBI ReBIT schema alignment (Tier 3) to serve banking/fintech customers, this requires a dedicated legal review before any schema work begins, since it brings the platform under RBI-regulated-entity obligations in addition to DPDP obligations. No implementation work has been done toward this; it is listed here only so it isn't decided as a purely technical matter later.

---

**Process note**: no item above is resolved by engineering judgment alone. Each requires a documented response from counsel before the corresponding feature is relied upon with real user data in production. The corresponding code paths (linked above) are structured so that if counsel's answer changes the requirement, the affected logic is isolated to a single module rather than scattered across the codebase.
