---
name: ddd-context-map
description: Document integration relationships between bounded contexts using Context Map patterns
---

# Context Map

A Context Map is an explicit diagram and document describing how Bounded Contexts relate to each other: who depends on whom, which team owns each context, and what integration pattern is used at each boundary. It makes the political and technical reality of a system visible.

## When to invoke

- Designing or reviewing the integration between two services or systems
- Starting work on a new bounded context that must communicate with existing ones
- Onboarding a team member who needs to understand the system landscape
- Deciding whether to use events, APIs, or shared schemas at a boundary

## Eight integration patterns

### 1. Partnership

Two teams collaborate closely on a shared interface. Changes are coordinated and planned together.

- **Use when:** both teams have aligned incentives, frequent communication, and joint planning
- **Risk:** tight coupling between teams — failure or slowdown of one blocks the other
- **Sign it has gone wrong:** one team waits for the other to merge before they can test

### 2. Shared Kernel

Two contexts share a subset of the domain model (code, schema, or types). Both teams must agree before changing the shared portion.

- **Use when:** there is a small, stable subset that genuinely belongs to both contexts
- **Risk:** the shared kernel grows over time and becomes a coupling point
- **Sign it has gone wrong:** the shared kernel contains logic that only one team uses

### 3. Customer–Supplier

The upstream (Supplier) provides a service; the downstream (Customer) depends on it. The customer's needs influence the supplier's roadmap, but the supplier has veto power.

- **Use when:** one team provides a platform or API that others consume
- **Risk:** the supplier does not prioritize the customer's needs
- **Mitigation:** customer writes acceptance tests that the supplier must pass before releasing

### 4. Conformist

The downstream conforms to the upstream's model with no negotiation. The upstream has no reason to accommodate the downstream.

- **Use when:** the upstream is a third-party system or an internal team with no incentive to change (finance, ERP, legacy)
- **Trade-off:** fast to implement; the downstream model is polluted with the upstream's concepts
- **Alternative:** use an Anticorruption Layer if the upstream model is harmful to the downstream domain

### 5. Anticorruption Layer (ACL)

The downstream creates a translation layer that converts the upstream's model into its own domain model. The downstream domain stays clean.

- **Use when:** the upstream model is complex, legacy, or semantically incompatible with the downstream domain
- **Cost:** additional code and maintenance; adds latency if synchronous
- **See also:** `/ddd-anti-corruption-layer` for the implementation pattern

### 6. Open Host Service (OHS) + Published Language (PL)

The upstream defines a protocol (OHS) and a well-documented, stable schema (PL) that any consumer can use without coordination. Think: a public REST API with a versioned OpenAPI spec.

- **Use when:** the upstream serves many consumers and cannot coordinate with all of them
- **Responsibility:** the upstream must maintain backward compatibility and version the Published Language
- **See also:** `/eng-api-design` for versioning and contract rules; `/eng-contract-testing` for consumer verification

### 7. Separate Ways

Two contexts have no integration. Teams solve overlapping problems independently.

- **Use when:** the cost of integration exceeds the benefit; duplication is intentional and bounded
- **Risk:** silent inconsistency if teams assume data flows between contexts when it does not
- **When to reconsider:** when the same user journey crosses both contexts and the seam is visible to users

### 8. Big Ball of Mud

An existing system with no clear context boundaries. Acknowledged as legacy; not a pattern to implement intentionally.

- **Use when:** describing a legacy system that must be integrated or strangled
- **Response:** wrap with an ACL; do not let its concepts leak into new contexts

## Drawing a Context Map

A Context Map is a diagram, not a data flow diagram. It shows:

1. **Each Bounded Context** as a named box with its owning team
2. **Integration lines** between contexts, labeled with the pattern (U = upstream, D = downstream)
3. **Direction of dependency** (arrow from downstream to upstream)

Example notation:
```
[Orders] --D/U--> [Inventory]   (Customer-Supplier)
[Orders] --ACL--> [Legacy ERP]  (Anticorruption Layer)
[Orders] --OHS-- [Notifications] (Open Host Service)
```

Keep the map at one level of abstraction. It should be understandable in under two minutes.

## Context Map as a living document

Store the Context Map in `adr/` or alongside the architecture documentation. Use `/adr-writer` to record decisions that change integration patterns. A Context Map that is not updated is worse than no map — it creates false confidence.

## Implementation checklist

- [ ] Every Bounded Context in the system is named and has a team owner
- [ ] Every integration line between contexts has an explicit pattern from the list above
- [ ] Upstream/downstream direction is marked for each relationship
- [ ] ACLs are implemented wherever a Conformist relationship would pollute the domain model
- [ ] Published Languages (schemas, OpenAPI specs) are versioned and backward-compatible
- [ ] The Context Map is stored in the repository and updated when boundaries change

## Review checklist

- [ ] No integration relationship described as "we call their API" without a named pattern
- [ ] No Shared Kernel that has grown beyond the agreed-upon shared subset
- [ ] No Customer-Supplier where the supplier has never seen the customer's acceptance tests
- [ ] No ACL that passes the upstream model through untranslated (defeating its purpose)

## Common mistakes

- Drawing the Context Map based on desired architecture instead of current reality — the map must reflect what exists, not what you want
- Confusing a Context Map with a service dependency graph — contexts are about team boundaries and domain models, not just network calls
- Choosing Conformist when an ACL would take one day to implement and save months of domain model pollution
- Not naming the patterns — "they talk to each other" is not a Context Map
- Letting the Shared Kernel grow into a shared library that every team depends on for different reasons (becomes a monolith in disguise)
