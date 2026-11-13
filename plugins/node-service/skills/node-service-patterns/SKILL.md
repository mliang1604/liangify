---
name: node-service-patterns
description: Structuring TypeScript services on Node — project layout, separating transports (HTTP, DIMSE, IPC) from domain logic so the same core runs as a server or inside Electron, configuration and secrets, structured logging, graceful shutdown, input validation at the boundary, and error-handling conventions. Framework-agnostic. Use when creating or reviewing backend/service code in TypeScript on Node.
---

# Node Service Patterns

A service that will run in several hosts — a server process, a container, inside an Electron app in standalone mode — must not assume any of them. The core rule: **domain logic knows nothing about transports, processes or environment**; thin adapters connect it to HTTP, DICOM networking, IPC, the file system and the database.

These patterns are framework-agnostic. When a project has chosen an HTTP framework, follow its idioms for routing and middleware, and keep the boundaries below.

## 1. Layout

```
server/
├── src/domain/          # entities, use cases, policies — pure TypeScript, no I/O imports
├── src/ports/           # interfaces the domain needs: DicomStore, StudyIndex, JobRunner, Clock, AuditLog
├── src/adapters/        # implementations: sqlite-index.ts, postgres-index.ts, fs-store.ts, native-job-runner.ts
├── src/transports/      # http/, dimse/, ipc/ — translate requests into use-case calls
├── src/config.ts        # load + validate configuration once
├── src/compose.ts       # composition root: build adapters from config, wire use cases
└── src/main.ts          # process entry: compose, start transports, handle signals
```

- **Domain imports nothing from `adapters/` or `transports/`.** Enforce it with lint rules (import boundaries) or project references.
- **One composition root** (`compose(config)`) builds everything. A server's `main.ts` and the Electron main process both call it with different configs — that's what makes standalone mode cheap.
- **No module-level singletons** holding connections, config or state. Pass dependencies explicitly (constructor or function parameters); it keeps tests and multi-host use simple.
- Use cases are functions or small classes with explicit inputs/outputs: `storeInstance(deps, { dataset, source })`, `findStudies(deps, query)`.

## 2. Transports are thin

A transport handler:

1. authenticates and authorizes the caller (see [service-security](../service-security/SKILL.md)),
2. **validates and parses** input into domain types,
3. calls one use case,
4. maps the result or error to the transport's response format.

No business rules, no SQL, no file paths in handlers. The same use case backs an HTTP endpoint, a DIMSE C-STORE handler and an Electron IPC call.

## 3. Configuration and secrets

- **Load once, validate, freeze.** Read environment variables / config files in `config.ts`, validate with a schema, fail fast at startup with a clear message listing every invalid or missing key. Everything else receives a typed `Config` object — nothing reads `process.env` directly.
- Support **layered sources**: defaults → config file → environment → CLI flags. Electron standalone passes config programmatically.
- **Secrets** (DB passwords, signing keys, TLS private keys) come from the environment, files mounted by the orchestrator, or the OS keychain (desktop) — never committed, never logged, never echoed in error messages. Print config at startup with secrets redacted.
- Paths (data directory, temp directory) are configuration, not `__dirname` arithmetic.

## 4. Structured logging

- Use a structured logger (JSON in production, pretty in development) with **levels** and **context fields** (`requestId`, `jobId`, `studyUid`), injected rather than imported globally.
- Generate a request/correlation ID at each transport boundary and propagate it (`AsyncLocalStorage` works well) into logs and job records.
- **Never log patient identifiers or other PHI** — names, patient IDs, dates of birth, accession numbers, free-text clinical fields, raw DICOM headers, request bodies. Log UIDs or internal IDs. Use an allow-list of loggable fields, not a deny-list. See service-security.
- Log errors once, at the boundary that handles them, with the stack; don't log-and-rethrow at every layer.

## 5. Errors

- Distinguish **expected domain errors** (not found, conflict, validation failed, forbidden) from **unexpected failures** (bugs, infrastructure down). Model domain errors explicitly — typed error classes with a `code`, or `Result` values — so transports can map them deterministically (e.g. `NotFound → 404` / DIMSE status `A700`-class failures as appropriate).
- Unexpected errors become a generic 500 / failure status with a correlation ID; details go to logs, not to the client.
- Always `await` or handle promises; enable `--unhandled-rejections=strict` behavior (default in modern Node) and treat an unhandled rejection as a crash to fix, not to swallow.
- Wrap errors with context (`new Error('loading study index', { cause })`) rather than replacing them.

## 6. Validation at the boundary

- **Every external input is untrusted:** HTTP bodies/params/headers, DIMSE datasets and identifiers, IPC arguments, files read from disk, environment variables, job outputs from native tools.
- Parse into domain types with a schema library or hand-written guards at the transport, then let the domain rely on the types. Reject unknown fields where it matters.
- Bound sizes and counts (request size, number of query results, string lengths) to protect memory.
- Validate file paths derived from input: resolve, `realpath`, and confirm they stay under the expected root.

## 7. Graceful shutdown and lifecycle

```ts
const app = await compose(config);
const servers = await startTransports(app);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => process.exit(1), config.shutdownTimeoutMs).unref();
  await servers.stopAccepting();     // stop new connections/associations
  await app.jobs.drainOrCancel();    // let running jobs finish or cancel them cleanly
  await servers.closeIdle();         // finish in-flight requests
  await app.close();                 // DB pools, file handles, child processes
  clearTimeout(timer);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
```

- Expose `start()`/`stop()` on the composed app so Electron can call them on `ready`/`before-quit` instead of relying on signals.
- **Health checks:** liveness (process responsive) and readiness (DB reachable, storage writable) endpoints, cheap and unauthenticated only if they reveal nothing.
- Child processes (native workers) must be terminated on shutdown — track them.

## 8. Performance hygiene

- **Never block the event loop** with CPU-heavy work (decompressing pixel data, large JSON, image math). Use `worker_threads`, a native helper process, or streaming.
- **Stream large payloads** (DICOM files, ZIP exports) end to end with `stream.pipeline`; never `readFile` a multi-hundred-MB file into memory to forward it.
- Use `AbortSignal` for cancellation through async call chains (client disconnects, job cancel, shutdown).
- Bound concurrency (connection pools, `p-limit`-style limiters) for DB, disk and child processes.

## 9. Review checklist

- [ ] Domain code has no imports from transports, adapters, `process.env` or framework packages.
- [ ] One composition root used by every host (server and Electron).
- [ ] Config validated at startup; secrets redacted; no direct `process.env` reads elsewhere.
- [ ] Inputs validated at each transport; sizes bounded; paths confined.
- [ ] Domain errors typed and mapped deterministically; unexpected errors don't leak details.
- [ ] Structured logs with correlation IDs and no PHI.
- [ ] Graceful shutdown stops intake, drains or cancels jobs, closes resources, with a timeout.
- [ ] No event-loop-blocking work; large data streamed.
