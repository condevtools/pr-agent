# Durable Run API

The API runs in the existing Nest application. PostgreSQL in the root Docker Compose file stores Runs, jobs, events, command receipts and publication outcomes. No Redis or Kafka is required. See [HARNESS.md](HARNESS.md) for database provisioning and publication authority.

## Authentication

Set `HARNESS_API_PRINCIPALS_JSON` in the server environment to a JSON array of credentials. An absent value disables the Run API with HTTP 503. Each entry has this shape:

```json
{
  "subjectId": "review-operator",
  "actorType": "user",
  "tenantId": "11111111-1111-4111-8111-111111111111",
  "integrationId": "22222222-2222-4222-8222-222222222222",
  "tokenSha256": "<64 lowercase hexadecimal characters>",
  "permissions": ["runs:create", "runs:read", "runs:trace", "runs:cancel"]
}
```

Generate a high-entropy bearer credential outside repository configuration and store only its SHA-256 digest in this array. Clients send exactly one `Authorization: Bearer <credential>` header. Do not put credentials in URLs. Changes to this configuration require an application restart. Deactivating an integration binding is checked on each request and event-stream poll. Use TLS at the ingress; the default Compose host binding is loopback only.

Permissions are independent: `runs:create`, `runs:read`, `runs:trace`, `runs:cancel`, `runs:resume`, `runs:retry`, `runs:recover`, and `runs:rerun`. The server binds each credential to a tenant and integration. Request bodies cannot select a tenant, repository, provider origin or credential. Missing or invalid credentials return 401, missing permissions 403, and resources outside the binding 404.

## Routes

| Route | Result |
| --- | --- |
| `POST /runs` | 202 with Run identity and links; requires `Idempotency-Key` |
| `GET /runs/:id` | Current state, version, publication status and any open manual wait |
| `GET /runs/:id/events?after=<cursor>&limit=100` | Durable public history, cursor, high-water mark and snapshot |
| `GET /runs/:id/events/stream` | SSE history followed by polling of durable events |
| `GET /runs/:id/trace?after=<cursor>` | Paginated internal execution metadata; requires `runs:trace` |
| `POST /runs/:id/commands/:kind` | 202 with a durable command receipt |

Create body:

```json
{"number": 42, "mode": "report"}
```

The optional `options` object accepts the existing review options. Unknown fields are rejected. The server reads the provider's current base/head revision and freezes it in the Run. A duplicate key with the same normalized request returns the original Run, including when provider metadata is temporarily unavailable. A different request under the same key returns 409. Creation requires an active integration enrolled in asynchronous review mode; the default remains synchronous analysis until administrative rollout.

Run states are `queued`, `running`, `retry_wait`, `waiting_for_reconciliation`, `waiting_for_user`, `succeeded`, `failed`, and `cancelled`. Publication status is separate: a cancelled Run can still have an external operation whose outcome is unknown. Run success proves workflow completion, not that every model finding is correct.

## Commands and manual decisions

Each command body contains `commandKey` and the current `expectedVersion`. The route selects the kind; a body field named `kind` is rejected. Replaying the same command returns the same receipt after checking current authorization. Reusing a key with different arguments or a stale version returns 409.

```json
{"commandKey": "cancel-42-once", "expectedVersion": 3}
```

- `cancel` records a request to stop further work. Already dispatched effects are reconciled separately.
- `retry` reschedules an eligible retry-wait Run without changing its identity.
- `recover` repairs an expired or orphaned execution without granting extra attempts.
- `rerun` creates a new Run with a parent link, the original fixed source revision, fresh budgets and current component versions. It does not inherit old approvals.
- `resume` consumes one specific manual wait and schedules a leased worker. The HTTP request itself cannot resolve the Run or send a publication.

Resume additionally supplies `decision`:

```json
{
  "commandKey": "confirm-operation-42",
  "expectedVersion": 8,
  "decision": {
    "waitId": "33333333-3333-4333-8333-333333333333",
    "waitVersion": 1,
    "intentHash": "<hash from the Run snapshot>",
    "operationVersion": 5,
    "decision": "confirm_occurred",
    "remoteId": "12345",
    "evidence": {
      "kind": "provider_confirmation",
      "reference": "provider inspection or incident record",
      "actualRevision": "<verified revision>"
    }
  }
}
```

The allowed decision list comes from the wait. `confirm_occurred` requires a remote object identity and actual revision. `confirm_not_occurred` records an attestation and opens a new wait; it does not resend. A separate `authorize_retry` decision is required before retrying the original frozen operation. `abandon_publication` ends publication without asserting that an unknown remote effect never occurred. Decisions are administrative attestations, not independently verified provider evidence.

Run-linked operations belonging to nonterminal Runs use this leased resume path. Once every linked Run is terminal, administrators can resolve the remaining operation through the existing `control` CLI. That path cannot authorize a new retry. A terminal Run is never revived by later reconciliation.

## Events and trace

Public event IDs are `<run UUID>:<sequence>`. Send the last processed ID as `Last-Event-ID` when reconnecting; it takes precedence over `after`. Deduplicate by ID. `cursor` events advance across internal records without revealing their payload. Keepalive comments are transport heartbeats, independent of worker lease renewal. `complete` ends a stream at the current terminal high-water mark; later external-outcome observations remain available through history or a new connection.

An expired cursor returns HTTP 410 with a snapshot and `resumeCursor`. Replace local state with that snapshot before resuming. A future cursor or cursor from another Run returns 400. A stream already open when authorization is revoked or history expires emits `stream_error` and closes. Slow consumers pause on socket backpressure and are disconnected when the buffer or drain timeout is exceeded; reconnect from the last processed ID.

Native browser `EventSource` cannot set this API's bearer header. Use a fetch-based SSE reader or a server-side client. Do not transfer the bearer into a query parameter as a workaround.

The default process limits are 1,024 concurrent streams, 64 per tenant/subject, a 256 KiB socket buffer ceiling and a 10-second drain timeout. These are protective limits, not measured capacity guarantees. Events poll PostgreSQL every second; keepalives use a 15-second interval.

Trace exposes step/call/receipt metadata and hashes. It does not return raw prompts, provider responses, checkpoints, authorization headers or private event payloads. Trace cursors are opaque and retain database timestamp precision.

## Validation

Run `npm test`, `npm run check`, `npm run build`, and `npm run test:harness:pg` from `backend`. The PostgreSQL runner creates a disposable PostgreSQL 17 Docker container and fresh database per suite, then removes only its own container. API tests use a real Nest HTTP server, a restricted database role and a local provider fixture. No live provider writes are needed.

多 Agent 深审可显式指定 `workflow: "review.deep.v1"`，并通过 `/runs/:id/artifact` 查询 shadow 报告。默认 single 的幂等行为不变。角色、证据门、预算和验证边界见 [深审说明](HARNESS_DEEP_REVIEW.md)。
