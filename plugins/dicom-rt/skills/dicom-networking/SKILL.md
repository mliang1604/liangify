---
name: dicom-networking
description: DICOM networking (DIMSE) — C-ECHO, C-STORE, C-FIND, C-MOVE and C-GET; AE titles, association negotiation, presentation contexts and transfer syntaxes; why C-MOVE needs configuration on both sides; query/retrieve information models; DICOM TLS; and how to build and test SCU/SCP services. Use when implementing or debugging DICOM network services, PACS integration, or node configuration.
---

# DICOM Networking (DIMSE)

DICOM's classic network protocol (PS3.7 message exchange, PS3.8 network communication, PS3.4 service classes) runs over TCP between **Application Entities**. Most integration failures are configuration — AE titles, ports, presentation contexts — not code. Design services so that configuration is explicit, validated and logged.

(DICOMweb — QIDO-RS, WADO-RS, STOW-RS over HTTP, PS3.18 — is the REST alternative. It's often simpler for web clients; DIMSE remains what modalities, TPSs and most PACS speak.)

## 1. Roles and identity

- An **Application Entity (AE)** is identified by an **AE title** (≤ 16 characters, case-sensitive in practice; avoid spaces and leading/trailing blanks) plus host and port.
- **SCU** (Service Class User) initiates a request; **SCP** (Service Class Provider) serves it. One application is often both (a PACS is a C-STORE SCP and a C-MOVE SCP, and a C-STORE SCU when it sends).
- Common ports: **104** (privileged, historical), **11112** (registered), **2762** for DICOM over TLS. Make the port configurable.
- **AE titles are not authentication.** Anyone who can reach the port can claim any AE title. Restrict by network and use TLS with client certificates where possible (§6).

## 2. Associations and presentation contexts

Every exchange happens inside an **association**:

1. The SCU sends **A-ASSOCIATE-RQ** with calling AE title, called AE title, and a list of **presentation contexts** — each pairs an *abstract syntax* (SOP class, e.g. CT Image Storage, Study Root Q/R FIND) with one or more *transfer syntaxes* it can send.
2. The SCP replies **A-ASSOCIATE-AC** accepting, per context, one transfer syntax — or rejects contexts it doesn't support (or rejects the whole association, e.g. unknown calling AE).
3. Messages flow on accepted contexts; then **A-RELEASE** (or **A-ABORT** on error).

Implications:

- **You can only send what was negotiated.** If the SCP didn't accept RT Dose Storage, a C-STORE of an RTDOSE fails. Propose a context for every SOP class you might send.
- **Transfer syntax mismatch:** if you have a JPEG 2000 file and the SCP only accepts Explicit VR Little Endian, you must transcode (decompress) or fail clearly. Always propose an uncompressed syntax as a fallback.
- Limit contexts to what you need (the protocol caps them at 128 per association).
- Log the negotiation result (accepted contexts and syntaxes) at debug level — it's the first thing you'll need when an integration fails.
- Respect `MaximumPDULength` and stream large objects; don't buffer whole multi-GB studies in memory.

## 3. Services (DIMSE-C)

| Service | Purpose | Notes |
|---|---|---|
| **C-ECHO** | Verification ("DICOM ping") | Use it to test connectivity and AE configuration before anything else. |
| **C-STORE** | Send one instance to an SCP | One request per instance. Check the response status: success, warnings (e.g. coercion of attributes) and failures (out of resources, data set doesn't match SOP class, cannot understand). |
| **C-FIND** | Query | Uses a **query/retrieve information model** (Patient Root or Study Root) and a **level** (PATIENT, STUDY, SERIES, IMAGE). Matching keys in the identifier filter; empty attributes request return values. Pending responses carry each match; the final response says done. Support cancel (C-CANCEL). |
| **C-MOVE** | Ask the SCP to send instances **to a destination AE** | The SCP opens a **new association** to the destination and does C-STOREs there. See §4. |
| **C-GET** | Ask the SCP to send instances **back on the same association** | Avoids the C-MOVE configuration problem, but the SCU must negotiate storage contexts (as SCP role) for every SOP class it wants back, and many PACS don't support it. |

- **Matching rules** (PS3.4 C.2.2.2): single value, wildcard (`*`, `?`), range for dates/times (`20260101-20260131`), UID list, sequence matching, universal (empty). Not every SCP supports every type; handle that gracefully.
- **Character sets:** honor `SpecificCharacterSet (0008,0005)` when decoding names and descriptions.

## 4. Why C-MOVE needs configuration on both sides

A C-MOVE request only names the **destination AE title**. The SCP (the archive) must already know **where that AE title lives** — host and port — in its own configuration, because it initiates the outbound association. So retrieving with C-MOVE requires:

1. the SCU's AE title, host and port registered on the **archive** as a known destination, and
2. the SCU (or another destination) running a **C-STORE SCP** that accepts the incoming association and the SOP classes/transfer syntaxes being sent, and
3. network reachability **from the archive to the destination** (firewalls and NAT often block this direction).

Typical failure: the C-MOVE response says "Move destination unknown" (status `A801`), or the move "succeeds" with zero instances because the outbound association was rejected. When building an SCP that serves C-MOVE, keep a validated table of known destinations; when building an SCU, document what the archive administrator must configure, or offer C-GET / DICOMweb as alternatives.

## 5. Building services

- **Use a maintained, permissively licensed DICOM networking library** rather than implementing PDUs yourself. Check its license is compatible with the project's.
- **Separate transport from domain logic:** the C-STORE handler validates and hands the dataset to a storage interface; the C-FIND handler translates the identifier into a query against an index interface. The same domain code then serves DIMSE, DICOMweb and in-process calls.
- **Validate inbound objects:** SOP class supported, required UIDs present, SOP Instance UID not conflicting with a different object already stored (decide a policy for duplicates: reject, keep first, replace, with an audit record).
- **Acknowledge after durable storage**, not before — the sender deletes its copy after a success status.
- **Accept-list calling AE titles** (and source addresses) for SCPs; reject unknown callers at association time.
- **Timeouts** on association, DIMSE and network reads; clean up half-open associations.
- **Concurrency limits:** bound the number of simultaneous associations and in-flight stores.
- **Audit** every association (who, from where), every stored and retrieved object (what), and every query — see the `node-service` plugin's `service-security` skill if installed. **Never log patient names, IDs or other identifiers in application logs**; log UIDs and AE titles, and keep identifying details in a protected audit trail.

## 6. DICOM TLS

- PS3.15 Annex B secure transport connection profiles: DICOM over **TLS** (typically port **2762**). Use current TLS versions and ciphers per the profile you claim (e.g. BCP 195 based profiles); disable legacy ones.
- **Mutual TLS** (client certificates) is the meaningful authentication mechanism for DIMSE; AE titles alone are not.
- Make certificate paths, trusted CAs and verification mode configuration, not code. Never ship "accept any certificate" as a default.
- Where a peer can't do TLS, terminate it at a gateway on a trusted network segment rather than disabling it in the application.

## 7. Testing

- **Unit-test** the domain handlers (query translation, storage policy) without a network.
- **Integration-test** against real peers in containers: e.g. an open-source PACS (Orthanc, dcm4chee) and the DCMTK or dcm4che command-line tools (`echoscu`, `storescu`, `findscu`, `movescu`, `getscu`, `storescp`). Cover: echo; store of each supported SOP class; find at each level with wildcards and ranges; move to a configured destination and to an unknown one; get; rejected AE title; unsupported transfer syntax; association abort mid-transfer.
- Use **synthetic data only** (see [dicom-test-data](../dicom-test-data/SKILL.md)).
- Record the conformance you actually support (SOP classes, roles, transfer syntaxes) in a **conformance statement** (PS3.2 template) and test against it.
