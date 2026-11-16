---
name: eng-api-design
description: Design REST APIs with correct versioning, contracts, pagination, and status codes
---

# API Design & REST Conventions

Guidelines for designing consistent, evolvable REST APIs. Covers resource naming, versioning strategies, HTTP semantics, status codes, pagination, and idempotency.

## When to invoke

- Designing a new REST endpoint or resource
- Reviewing an existing API for consistency and correctness
- Deciding on a versioning or pagination strategy
- Evaluating whether an HTTP method or status code is appropriate

## Core concepts

### Resource Naming

- Use **nouns, not verbs**: `/orders`, not `/getOrders` or `/createOrder`
- Use **plural** resource names: `/users/{id}`, `/invoices/{id}/items`
- Nest resources only when the child cannot exist without the parent (max 2 levels deep)
- Use **kebab-case** for multi-word segments: `/payment-methods`, not `/paymentMethods`

### Versioning

| Strategy | When to use |
|---|---|
| URI path (`/v1/orders`) | Simplest; easy to test and cache; recommended default |
| Header (`Accept: application/vnd.api+json;version=2`) | Cleaner URIs; harder to test manually |
| Query param (`?version=2`) | Avoid — pollutes query space, not semantically clean |

- Introduce a new version only for **breaking changes**; non-breaking additions do not require a new version
- Keep the previous version alive for a documented sunset period; communicate via `Sunset` response header

### HTTP Method Semantics

| Method | Semantics | Safe | Idempotent |
|---|---|---|---|
| GET | Read | Yes | Yes |
| POST | Create / trigger | No | No |
| PUT | Full replace | No | Yes |
| PATCH | Partial update | No | No (unless designed so) |
| DELETE | Remove | No | Yes |

### Status Codes

| Code | Use when |
|---|---|
| 200 OK | Successful GET, PUT, PATCH |
| 201 Created | Successful POST that created a resource; include `Location` header |
| 204 No Content | Successful DELETE or action with no response body |
| 400 Bad Request | Malformed request syntax or invalid parameters |
| 401 Unauthorized | Missing or invalid authentication |
| 403 Forbidden | Authenticated but not authorized |
| 404 Not Found | Resource does not exist |
| 409 Conflict | State conflict (duplicate, optimistic lock failure) |
| 422 Unprocessable Entity | Syntactically valid but semantically invalid (business rule violation) |
| 429 Too Many Requests | Rate limit exceeded; include `Retry-After` header |
| 500 Internal Server Error | Unexpected server fault |

### Pagination

| Strategy | Best for |
|---|---|
| **Cursor** (`?after=<opaque_cursor>`) | Large, frequently updated datasets; preferred |
| **Offset** (`?page=2&limit=20`) | Simple use cases; avoid for large datasets (inconsistent results on insert/delete) |

Always include in the response: `data`, `next_cursor` (or `next`), and optionally `total`.

### Idempotency

- For non-idempotent operations (POST, PATCH), support an `Idempotency-Key` header
- Store the key + result for a defined window (e.g., 24 hours); return cached result on duplicate
- Critical for payment, order creation, and any operation with real-world side effects

## Implementation checklist

- [ ] Resources use plural nouns; no verbs in URI paths
- [ ] Version is included from day one, even if only `/v1/`
- [ ] Each endpoint uses the semantically correct HTTP method
- [ ] Success and error responses use the appropriate status codes from the table above
- [ ] Pagination is implemented for every list endpoint (never return unbounded lists)
- [ ] `Idempotency-Key` is supported for all non-idempotent, side-effectful operations
- [ ] Error responses include a machine-readable `code` and a human-readable `message`

## Review checklist

- [ ] No verbs in URI paths
- [ ] Breaking changes increment the API version
- [ ] 401 and 403 are not confused
- [ ] List endpoints always have a page size limit
- [ ] POST endpoints that create resources return 201 with a `Location` header
- [ ] Idempotency keys are implemented for payment and order endpoints

## Common mistakes

- Using GET with a body (not supported by all intermediaries)
- Returning 200 with `{"success": false}` instead of the appropriate 4xx/5xx
- Embedding actions as verbs in URIs (`/users/activate`) instead of using a sub-resource (`/users/{id}/activation`)
- Paginating by offset on large, mutable datasets (results shift on concurrent writes)
- Versioning every minor change (only break version on breaking changes)
