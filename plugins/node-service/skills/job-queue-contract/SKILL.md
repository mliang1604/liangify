---
name: job-queue-contract
description: Long-running work as jobs in Node services — the job lifecycle (submit, status, progress, cancel, result), persistence and idempotency, starting native command-line workers (e.g. C++ registration tools) from Node with input files and parameters, parsing machine-readable progress, timeouts, exit-code mapping, cancellation and cleanup of temporary files, and running the same contract on a server or inside Electron. Use when adding background processing, wrapping a CLI tool, or reviewing job-runner code.
---

# Job Queue Contract

Anything that can take more than a request's lifetime — registration, dose accumulation, large imports, exports — is a **job**, not a long HTTP call. Jobs have a uniform contract so the UI, the server and the desktop app treat every kind of work the same way, and so native tools can be swapped without touching callers.

## 1. The contract

```ts
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobRecord<P = unknown, R = unknown> {
  id: JobId;
  kind: string;                    // e.g. 'registration.rigid', 'dose.accumulate'
  params: P;                       // validated, serializable inputs (UIDs, settings) — never raw paths from clients
  state: JobState;
  progress?: { fraction: number; stage?: string; message?: string };  // fraction 0..1
  result?: R;                      // on success: references to outputs (e.g. new SOP Instance UIDs)
  error?: { code: string; message: string };                          // on failure: safe for clients
  createdBy: UserId;
  createdAt: string; startedAt?: string; finishedAt?: string;
  idempotencyKey?: string;
}

export interface JobService {
  submit<P>(kind: string, params: P, opts: { user: UserId; idempotencyKey?: string }): Promise<JobRecord>;
  get(id: JobId, user: UserId): Promise<JobRecord | null>;
  list(filter: JobFilter, user: UserId): Promise<PageOf<JobRecord>>;
  cancel(id: JobId, user: UserId): Promise<JobRecord>;
  subscribe(id: JobId, listener: (job: JobRecord) => void): Unsubscribe;   // SSE/WebSocket/IPC push
}
```

- **States are a closed set**; transitions only `queued → running → succeeded|failed|cancelled` (and `queued → cancelled`). Terminal states never change.
- **Submit returns immediately** with the job ID (HTTP `202 Accepted` + location); clients poll `get` or subscribe for updates.
- **Params are validated at submit** and must be enough to re-run the job (reproducibility). Store tool versions and parameters with the result.
- **Idempotency key** on submit makes client retries safe: the same key + user returns the existing job.
- **Authorization**: users see and cancel only their jobs (or per policy); every submit, cancel and result access is audited (see [service-security](../service-security/SKILL.md)).
- Persist job records in the index store (SQLite/PostgreSQL), so status survives restarts. On startup, jobs left `running` by a crash become `failed` (code `interrupted`) or are re-queued if the kind is safe to retry.

## 2. Execution: a bounded worker pool

- A runner takes `queued` jobs with **bounded concurrency** per kind (CPU-heavy registration might be 1–2 at a time; light jobs more).
- Each job gets an `AbortController`; `cancel()` aborts it. Cancellation must be **prompt and leave no partial outputs** registered.
- Server deployments with several instances need a shared queue (DB row locking such as `SELECT ... FOR UPDATE SKIP LOCKED`, or a queue service). Desktop standalone uses the same `JobService` interface with an in-process runner and SQLite.

## 3. Running native command-line workers

Native tools (C++/ITK/elastix, etc.) follow a CLI contract (see the `cpp-itk` plugin's `cli-worker-contract` skill, if installed): arguments and files in, machine-readable progress on stdout, results in an output directory, meaningful exit codes, no prompts.

```ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function runWorker(spec: WorkerSpec, signal: AbortSignal, onProgress: (p: Progress) => void) {
  const work = await mkdtemp(path.join(spec.tempRoot, `job-${spec.jobId}-`));
  try {
    await writeInputs(work, spec);                         // materialize input files (e.g. DICOM series → work/in/)
    const args = ['--input', path.join(work, 'in'), '--output', path.join(work, 'out'),
                  '--params', path.join(work, 'params.json'), '--progress', 'jsonl'];
    const child = spawn(spec.executable, args, {
      cwd: work, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { PATH: process.env.PATH ?? '', ...spec.env },  // minimal, explicit environment
    });

    const timeout = setTimeout(() => child.kill('SIGTERM'), spec.timeoutMs);
    signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });

    const stderrTail = new RingBuffer<string>(50);
    createInterface({ input: child.stderr }).on('line', (l) => stderrTail.push(l));
    for await (const line of createInterface({ input: child.stdout })) {
      const msg = parseWorkerLine(line);                   // validate: {"type":"progress","fraction":0.4,"stage":"optimize"}
      if (msg?.type === 'progress') onProgress(msg);
    }
    const code: number | null = await new Promise((r) => child.on('close', r));
    clearTimeout(timeout);

    if (signal.aborted) throw new JobCancelled();
    if (code !== 0) throw new WorkerFailed(mapExitCode(code), stderrTail.toArray());
    return await readOutputs(path.join(work, 'out'), spec); // validate outputs before trusting them
  } finally {
    await rm(work, { recursive: true, force: true });       // always clean up
  }
}
```

Rules:

- **`spawn` with an argument array, never a shell string** (`exec`, `shell: true`) — no injection, no quoting bugs, works the same on Windows.
- **Absolute path to a known executable** from configuration / the bundled helper location; never a name looked up from user input.
- **Minimal explicit environment**; don't leak the service's secrets into child processes.
- **Parse progress line by line** (JSON Lines), ignore/count malformed lines, and throttle progress updates to clients.
- **Capture a bounded tail of stderr** for diagnostics; don't stream unbounded output into memory or logs, and scrub it before logging (it may contain paths or identifiers).
- **Timeouts** per job kind; on timeout or cancel send SIGTERM, then SIGKILL after a grace period. On Windows, `kill()` terminates the process; if the tool spawns children, kill the process tree.
- **Map exit codes** to stable error codes (`0` success, documented non-zero codes → `invalid-input`, `registration-diverged`, `out-of-memory`, …; anything else → `worker-crashed`). Clients see the stable code, not the raw number.
- **Validate outputs** (files exist, parse, values in range, geometry consistent) before registering them as results. A zero exit code is not proof of a correct result.
- **Temp directories** per job under a configured temp root, removed in `finally`; a startup sweeper removes leftovers from crashes.
- Record the **tool name, version** (`--version` at startup) and parameters with the result for traceability.

## 4. Results

- Results are **new, immutable objects** (e.g. a new DICOM REG/DSR or RTDOSE instance with new UIDs) stored through the normal storage path, plus a reference in the job record. Never overwrite inputs.
- Clients fetch results by reference, with the same authorization as any other object.
- Keep job records for a retention period; results follow the data retention policy, not the job's.

## 5. Progress to clients

- Push updates over the transport the client already uses: Server-Sent Events or WebSocket for the web client, IPC events in Electron, polling as a fallback.
- Progress is advisory: monotonic `fraction` per stage where possible, a human-readable `stage`, no PHI in messages.

## 6. Testing

- Test the runner with a **fake worker script** (a tiny Node script) that emits chosen progress lines, writes chosen outputs, sleeps, and exits with chosen codes — covering success, each mapped failure, malformed progress, timeout, cancel mid-run, and crash (signal).
- Assert temp directories are removed in every path, and that cancelled/failed jobs register no results.
- Integration-test with the real native tool on synthetic inputs with known answers (see the `dicom-rt` plugin's `dicom-test-data` skill, if installed).

## 7. Review checklist

- [ ] Long work goes through `JobService`; submit returns immediately; states and transitions are closed.
- [ ] Params validated and stored; idempotency key honored; access authorized and audited.
- [ ] Workers spawned with argument arrays, absolute executable paths and minimal env.
- [ ] Timeouts, cancellation (SIGTERM → SIGKILL) and exit-code mapping implemented.
- [ ] Outputs validated before use; results stored as new immutable objects.
- [ ] Temp files cleaned up in `finally` and swept at startup.
- [ ] Jobs left running by a crash are resolved on restart.
