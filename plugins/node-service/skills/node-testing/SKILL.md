---
name: node-testing
description: Testing TypeScript services on Node — Vitest unit tests for domain logic and use cases with fakes, contract tests shared across storage backends, integration tests that start the service against real peers in containers (PostgreSQL, a DICOM archive, DCMTK tools) with Testcontainers or docker compose, test data isolation, and CI layout. Use when writing or reviewing tests for backend code or setting up service CI.
---

# Node Service Testing

Fast unit tests for the logic, a shared contract suite for every adapter, and a smaller set of integration tests that run the real service against **real peers in containers**. Mocking a database or a DICOM peer tells you the code matches your assumptions; containers tell you the code matches reality.

## 1. Layers

| Layer | Runs | Uses | Covers |
|---|---|---|---|
| **Unit** | Every commit, seconds | Vitest, in-process fakes | Domain rules, use cases, validation, error mapping, job state machine |
| **Contract** | Every commit (SQLite/fs) + integration job (PostgreSQL, object storage) | Shared suites per port | Each adapter satisfies its interface (see [storage-abstraction](../storage-abstraction/SKILL.md)) |
| **Integration** | Every PR in CI, minutes | Real service + containers | Transports end to end: HTTP API, DIMSE services, migrations, auth, audit |
| **Smoke / E2E** | Release pipeline | Deployed or packaged build | It starts, it's healthy, the main flows work |

## 2. Unit tests with Vitest

- Vitest for TypeScript on Node: fast, ESM-native, same runner as the web client. Configure `environment: 'node'`.
- Test **use cases through their ports** with small fakes (in-memory index that passes the contract suite, a fake clock, a fake job runner). Avoid `vi.mock()` of modules when you can inject a dependency instead.
- **Inject time and randomness** (`Clock`, ID generators) so tests are deterministic; use `vi.useFakeTimers()` only for timer-driven code (retries, timeouts, sweepers).
- Test **error paths as much as happy paths**: validation failures, not-found, conflicts, permission denied, worker failures and timeouts.
- Keep units free of network and file system; the few tests that need files use a fresh temp directory (`mkdtemp`) cleaned up in `afterEach`.

## 3. Integration tests against real peers

Start dependencies as containers for the test run — [Testcontainers for Node](https://node.testcontainers.org/) from the test setup, or a `docker compose` file the CI job brings up:

```ts
// test/integration/setup.ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';

export async function startPeers() {
  const pg = await new PostgreSqlContainer('postgres:17-alpine').start();
  const orthanc = await new GenericContainer('orthancteam/orthanc')
    .withExposedPorts(4242, 8042)
    .withEnvironment({ ORTHANC__DICOM_AET: 'ORTHANC', ORTHANC__AUTHENTICATION_ENABLED: 'false' })
    .withWaitStrategy(Wait.forHttp('/system', 8042))
    .start();
  return {
    databaseUrl: pg.getConnectionUri(),
    archive: { host: orthanc.getHost(), port: orthanc.getMappedPort(4242), aet: 'ORTHANC' },
    async stop() { await Promise.all([pg.stop(), orthanc.stop()]); },
  };
}
```

- **Pin image versions** (tags or digests) so tests don't break when an image updates.
- Start the **real service** via its composition root (`compose(testConfig)` + `start()`) on an ephemeral port, pointed at the containers. Test through its public transports: HTTP with `fetch`, DIMSE with a client library or DCMTK CLI tools in a container (`echoscu`, `storescu`, `findscu`, `movescu`).
- Cover the cross-system behaviors that mocks miss: migrations on a real PostgreSQL; C-STORE/C-FIND/C-MOVE round trips with a real archive (including C-MOVE to a destination that the archive must be configured with); TLS handshakes; large streaming uploads and downloads; restart with jobs in flight.
- **Isolate per test file or suite:** a fresh database (or schema) and data directory per suite; don't share mutable state between files. Reuse containers across tests within a run for speed, not data.
- **Synthetic data only** for any DICOM content (see the `dicom-rt` plugin's `dicom-test-data` skill, if installed).
- Set generous but finite timeouts for container startup; fail with the container logs attached.

## 4. Testing the security and audit behavior

- Use test identities/tokens from a test identity provider container or a local signing key configured only in test.
- Assert authorization (401/403/IDOR), audit records written for sensitive actions, and **no PHI in captured application logs** — capture logs into memory during integration tests and scan them for the synthetic patient names/IDs used.

## 5. CI layout

- **Job 1 (every push):** typecheck, lint, unit + SQLite/fs contract tests. Should finish in a couple of minutes.
- **Job 2 (every PR):** integration tests with containers (Docker available on Linux runners). Upload container logs and test reports on failure.
- Run the **same commands locally** (`npm test`, `npm run test:integration`); document Docker as the only extra prerequisite.
- Coverage from unit + integration combined is informative; don't gate on a number that encourages testing getters.

## 6. Review checklist

- [ ] Domain and use cases have unit tests with injected fakes, including error paths.
- [ ] Every adapter runs the shared contract suite; PostgreSQL in CI, not only SQLite.
- [ ] Integration tests start the real service against pinned containers and test through public transports.
- [ ] Tests are isolated (fresh DB/data dir per suite), deterministic (injected clock/IDs) and use synthetic data.
- [ ] Security, audit and log-leak behavior is tested, not assumed.
