---
name: ddd-bounded-context
description: Define explicit model boundaries and map integration relationships between contexts
---

# Bounded Context

An explicit boundary within which a domain model is defined and applicable. Terms, rules, and models inside the boundary have precise meaning; the same word may mean something different in another context.

## When to invoke

- Designing a new subsystem or service
- Integrating with an external system or legacy application
- Resolving naming conflicts where the same word means different things to different teams
- Deciding how two subsystems should communicate

## Core concepts

Each integration point between bounded contexts must choose a **Context Map pattern**:

| Pattern | Use when |
|---|---|
| **Partnership** | Two teams succeed or fail together; coordinate continuously |
| **Shared Kernel** | Both contexts share a small, consciously maintained model subset |
| **Customer-Supplier** | Upstream provides; downstream consumes (upstream sets the terms) |
| **Conformist** | Downstream accepts upstream model as-is, no translation |
| **Anti-Corruption Layer** | Downstream translates upstream model to protect its own model |
| **Open Host Service** | Upstream publishes a protocol others consume (REST API, events) |
| **Published Language** | Shared, documented interchange format (JSON schema, Protobuf) |
| **Separate Ways** | No integration; each context solves its own problem independently |

## Implementation checklist

- [ ] Name the bounded context using domain language, not technical terms
- [ ] Document the context's purpose and the Ubiquitous Language it owns
- [ ] For each integration point, choose and document the Context Map pattern
- [ ] Implement an Anti-Corruption Layer when integrating with systems you do not control
- [ ] Ensure no domain model leaks across boundaries without explicit translation

## Review checklist

- [ ] Each bounded context has clear entry points (API, events, or ACL)
- [ ] No domain object from one context is used directly in another without translation
- [ ] Context Map relationships are documented and reflect the actual integration approach
- [ ] The same term used in two contexts has intentionally different models — documented

## Common mistakes

- Creating a "God" bounded context that tries to model the entire business
- Sharing database tables between bounded contexts
- Treating a bounded context and a microservice as synonymous
- Allowing domain objects to cross boundaries as shared libraries
