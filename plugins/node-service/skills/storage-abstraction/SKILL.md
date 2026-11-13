---
name: storage-abstraction
description: Storage behind small interfaces in Node/TypeScript services — designing ports such as a DICOM object store and a study index, interchangeable backends (SQLite for standalone/desktop, PostgreSQL for servers, file system or object storage for blobs), migrations, transactions and idempotency, shared contract tests, and streaming large files instead of buffering them. Use when designing persistence, adding a backend, writing migrations or handling large binary data.
---

# Storage Abstraction

The same service must store data on a single user's laptop (SQLite + local files) and on a hospital server (PostgreSQL + shared or object storage). Make that a configuration choice, not a fork, by writing the domain against **small, purpose-specific interfaces** and proving every backend satisfies them with **one shared contract test suite**.

## 1. Design small ports, by use

Split by what the data is and how it's accessed — not one giant "repository":

```ts
/** Immutable binary objects (e.g. DICOM Part 10 files), addressed by key. */
export interface ObjectStore {
  put(key: ObjectKey, data: Readable, opts?: { expectedSha256?: string }): Promise<StoredObject>;
  get(key: ObjectKey, range?: ByteRange): Promise<Readable>;          // stream, never Buffer
  head(key: ObjectKey): Promise<StoredObject | null>;
  delete(key: ObjectKey): Promise<void>;
}

/** Queryable metadata: patients/studies/series/instances and their attributes. */
export interface StudyIndex {
  upsertInstance(meta: InstanceMetadata, tx?: Tx): Promise<UpsertResult>;
  findStudies(query: StudyQuery, page: Page): Promise<PageOf<StudySummary>>;
  getSeries(seriesUid: Uid): Promise<SeriesDetail | null>;
  withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
```

- **Interfaces speak domain types** (UIDs, query objects, pages), never SQL fragments, ORM entities or backend-specific options.
- **Keep them minimal.** Add a method when a use case needs it; a method only one backend can implement efficiently is a design smell — rethink the query.
- **Pagination and limits are part of the contract** (cursor or offset + max page size). No unbounded "list all".
- **Blobs and metadata are separate ports.** Large binaries never go in the relational database.

## 2. Backends

| Concern | Standalone / desktop | Server |
|---|---|---|
| Metadata index | **SQLite** (single file under the app's data directory; WAL mode) | **PostgreSQL** |
| Objects | Local file system under a data root | File system (shared volume) or S3-compatible object storage |
| Concurrency | One process, modest concurrency | Many requests, multiple instances |

- Choose the backend in the composition root from config: `index: { kind: 'sqlite', path } | { kind: 'postgres', url }`.
- **Write portable SQL** (or use a query builder that supports both) and keep dialect differences inside the adapter. Where behavior differs (upsert syntax, JSON operators, case sensitivity, collation, `LIKE` vs `ILIKE`), the contract tests decide what "correct" is.
- **SQLite specifics:** enable WAL, set `busy_timeout`, use a single writer connection (serialize writes), enable foreign keys (off by default), and keep the file on local disk (not a network share).
- **PostgreSQL specifics:** connection pool with bounded size, statement timeouts, TLS to the database, least-privilege DB user (no DDL rights at runtime if migrations run separately).

## 3. Writes: transactions, idempotency, consistency

- **Object first, then index, in that order**, so the index never points at a missing object: write the blob to a temporary key → fsync/verify checksum → move/commit to its final key → insert the index row in a transaction. A crash between steps leaves an orphan blob (cleaned up by a sweeper), never a dangling index row.
- **Idempotent stores:** receiving the same SOP Instance twice must be safe. Key objects by a stable identity (e.g. SOP Instance UID plus content hash), use upserts, and define the duplicate policy explicitly (ignore identical, reject conflicting, or version) — with an audit record.
- **Transactions are explicit** (`withTransaction`) and short; never hold one open across network calls or file streaming.
- Record **checksums** (SHA-256) for stored objects; verify on read when cheap or periodically.

## 4. Migrations

- Versioned, ordered migration files per backend (or one source generating both dialects), applied by a migration tool at startup (desktop) or as a separate deploy step (server).
- **Forward-only in production**; write migrations that are safe to run on live data (add nullable column → backfill → add constraint) and avoid long locks on large tables.
- Test migrations: an empty database migrated to head, and a database at the previous release's schema with representative synthetic data migrated to head.
- Store the schema version in the database; refuse to start against a newer schema than the code knows.

## 5. Streaming large files

DICOM studies can be gigabytes. Treat every object as a stream:

```ts
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

export async function putFile(root: string, key: ObjectKey, input: Readable, signal?: AbortSignal) {
  const tmp = path.join(root, '.tmp', randomUUID());
  const hash = createHash('sha256');
  await pipeline(input, new HashPassThrough(hash), createWriteStream(tmp, { flags: 'wx' }), { signal });
  const sha256 = hash.digest('hex');
  const final = objectPath(root, key);
  await mkdir(path.dirname(final), { recursive: true });
  await rename(tmp, final);                       // atomic on the same file system
  return { key, sha256, size: (await stat(final)).size };
}
```

- **`stream.pipeline`** (promise form) for every copy — it propagates errors and backpressure and cleans up on failure. Never `.pipe()` without error handling.
- **No `readFile`/`Buffer.concat` of whole objects** in request paths. Parse only the header bytes you need (e.g. read DICOM metadata up to Pixel Data).
- Support **range reads** for objects that clients fetch partially.
- Pass an `AbortSignal` so a cancelled request or job stops I/O.
- Write to a temp path and **rename atomically**; clean up temp files on failure and with a periodic sweeper.
- **Confine keys to the data root:** derive file paths from validated keys (e.g. hashed or UID-based segments), never from user-supplied names.

## 6. Contract tests: one suite, every backend

```ts
export function describeStudyIndexContract(name: string, make: () => Promise<StudyIndex & { dispose(): Promise<void> }>) {
  describe(`StudyIndex contract: ${name}`, () => {
    let index: Awaited<ReturnType<typeof make>>;
    beforeEach(async () => { index = await make(); });
    afterEach(() => index.dispose());

    it('upserting the same instance twice is idempotent', async () => { /* ... */ });
    it('findStudies matches wildcards and date ranges', async () => { /* ... */ });
    it('pagination returns every result exactly once', async () => { /* ... */ });
    it('a failed transaction leaves no partial rows', async () => { /* ... */ });
  });
}

describeStudyIndexContract('sqlite (in-memory)', () => makeSqliteIndex(':memory:'));
describeStudyIndexContract('postgres (container)', () => makePostgresIndex(testDatabaseUrl()));
```

- The **same tests** run against every backend; a backend is done when it passes the suite. Run SQLite in every test run; run PostgreSQL in integration jobs (see [node-testing](../node-testing/SKILL.md)).
- Include ordering, collation/case, unicode, null handling, concurrency (two writers), and large-result pagination in the suite — that's where dialects differ.
- An in-memory fake for unit tests of use cases is fine **only if it also passes the contract suite**.

## 7. Review checklist

- [ ] Domain depends on small storage interfaces with domain types, not on a database client or ORM.
- [ ] Backend chosen in the composition root from config; no dialect checks in domain code.
- [ ] Blobs streamed end to end with `pipeline`, written to temp then atomically renamed, checksummed.
- [ ] Object-then-index write order; idempotent upserts with an explicit duplicate policy.
- [ ] Migrations versioned, tested from empty and from the previous release.
- [ ] Every backend passes the shared contract suite.
