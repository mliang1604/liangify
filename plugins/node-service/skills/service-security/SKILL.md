---
name: service-security
description: Security for services that handle medical/patient data — authentication and authorization (including for DICOM network peers), audit logging of who accessed, changed or sent what, encryption in transit and at rest, secrets handling, never logging patient identifiers, and secure defaults for local/standalone mode. Use when adding endpoints, network services, logging, user/role logic or deployment configuration to a service.
---

# Service Security

A radiotherapy imaging service holds protected health information (PHI). The baseline is: **every access is authenticated, authorized and auditable; data is encrypted in transit; and patient identifiers never leak into logs, errors, metrics or URLs.** Regulations (HIPAA, GDPR and local equivalents) set requirements on top of this; the engineering defaults below make compliance possible rather than retrofitted.

## 1. Authentication

- **Web/API clients:** use a standard protocol — OpenID Connect against the organization's identity provider for server deployments. Validate tokens properly (signature, issuer, audience, expiry, clock skew) with a maintained library; never hand-roll JWT parsing.
- **Sessions:** short-lived access tokens; refresh handled by the client library; cookies (if used) `HttpOnly`, `Secure`, `SameSite`; CSRF protection for cookie-authenticated state-changing requests.
- **Service-to-service:** mTLS or scoped client credentials; no shared static passwords in config files.
- **DICOM (DIMSE) peers:** AE titles are identifiers, not credentials. Combine an **allow-list of AE title + source address** with **TLS and client certificates** where peers support it (see the `dicom-rt` plugin's `dicom-networking` skill, if installed).
- **Standalone/desktop mode:** the local service binds to `127.0.0.1` only and requires a per-launch random token supplied to the UI process, so other local programs and web pages can't call it.

## 2. Authorization

- **Deny by default.** Every endpoint and use case declares the permission it requires; a missing declaration fails closed (enforce with a test that enumerates routes).
- Check authorization **in the use case or a policy layer**, not only in the UI or route config, so every transport (HTTP, DIMSE, IPC) gets the same rules.
- Model **roles and scopes** (viewer, planner, physicist, admin) and, where needed, **data scopes** (which studies/sites a user may see). Filter queries by scope in the storage layer — never fetch everything and filter in memory or in the client.
- Protect against **IDOR**: fetching `/studies/{uid}` checks that this user may see that study, every time.
- Administrative operations (deleting data, changing configuration, managing peers) require elevated roles and are always audited.

## 3. Audit logging

Audit logs answer "who did what to which data, when, from where, and was it allowed". They are **separate from application logs**:

- Record: actor (user ID or peer AE/cert), action (view, query, store, export, send, delete, modify, login, permission change), object references (Study/Series/SOP Instance UIDs, job IDs), outcome (success/denied/failed), timestamp (UTC), source (IP/host, client app), correlation ID.
- Cover **reads and queries**, not just writes — viewing a patient's images is an auditable event. Cover data **leaving** the system: exports, C-STORE/C-MOVE to other nodes, downloads.
- Make the audit trail **append-only and tamper-evident** (write-only DB role, hash chaining or forwarding to a separate log store), with its own access control and retention policy.
- Where interoperability matters, align events with **IHE ATNA** / DICOM audit message schemas (PS3.15 Annex A.5) and support forwarding via syslog over TLS.
- Audit records may contain object UIDs but should avoid patient names or other direct identifiers unless the audit policy requires them and the store is protected accordingly.
- Failure to write an audit record for a sensitive action should fail the action (or at least alert) — decide and document.

## 4. Never log patient identifiers

Application logs, metrics, traces, error reports and crash dumps travel widely (log aggregators, support tickets, vendors). Keep PHI out:

- **Never log:** patient name, patient ID/MRN, date of birth, accession number, addresses, free-text clinical fields, raw DICOM headers or datasets, request/response bodies, file names derived from patient data, query parameters from search forms.
- **Do log:** internal IDs, UIDs (study/series/instance — still treat logs as sensitive), job IDs, correlation IDs, counts, durations, error codes.
- Enforce mechanically: an **allow-listed log schema** (structured fields only), a logger serializer that drops unknown fields, and a redaction pass for error messages that may echo input. Add tests that feed PHI-looking input through error paths and assert it doesn't appear in captured logs.
- **No PHI in URLs** (paths or query strings) — they end up in proxy logs, browser history and referrers. Use POST bodies or opaque IDs for searches.
- **No PHI in metrics labels or trace attributes.**
- Exception messages returned to clients are generic; details stay in protected logs.

## 5. Encryption and transport

- **TLS everywhere** off-host: HTTPS for the API (HSTS where applicable), TLS for database connections, DICOM TLS for DIMSE, TLS syslog for audit forwarding. Current protocol versions and cipher suites only; certificate verification always on.
- **At rest:** rely on encrypted volumes/managed disks for servers and OS disk encryption for desktops at minimum; consider application-level encryption for exports and backups that leave the system.
- **Secrets:** from a secret manager, orchestrator-mounted files or the OS keychain (desktop); rotated; never in the repo, images, logs or crash reports.

## 6. Defensive defaults

- Validate and bound all inputs (see [node-service-patterns](../node-service-patterns/SKILL.md)); limit request sizes and rates; set timeouts.
- Security headers on HTTP responses (CSP for any served UI, `X-Content-Type-Options: nosniff`, frame restrictions); CORS limited to known origins — never `*` with credentials.
- Dependency hygiene: lockfiles, `npm ci`, automated vulnerability alerts, minimal dependencies; no `postinstall` scripts from untrusted packages in production images.
- Run with least privilege: non-root container user, read-only root filesystem where possible, DB user without DDL rights at runtime.
- Exports and anonymization: anonymization profiles follow DICOM PS3.15 Annex E (attribute confidentiality profiles); never treat an "anonymized" export as non-sensitive by default.

## 7. Testing

- Authorization tests per endpoint/use case: unauthenticated → 401; wrong role/scope → 403; cross-tenant/IDOR attempts denied.
- A route inventory test that fails if any endpoint lacks an explicit permission.
- Audit tests: each sensitive action produces exactly the expected audit record, including denied attempts.
- Log-leak tests: PHI-like synthetic values pushed through success and failure paths never appear in application logs.
- TLS configuration tests in integration (reject plaintext, reject invalid certificates).

## 8. Review checklist

- [ ] Every endpoint/handler authenticates and checks an explicit permission; deny by default.
- [ ] Data-scope filtering happens in queries; IDOR checks on every object access.
- [ ] Reads, queries, exports and sends are audited, append-only, separate from app logs.
- [ ] No PHI in logs, errors, URLs, metrics or traces; enforced by schema and tests.
- [ ] TLS on every off-host connection with verification on; secrets from a secret store.
- [ ] Standalone mode bound to loopback with a launch token.
