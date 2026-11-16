---
name: architecture-from-requirements
description: Turn a structured requirement or spec into a concrete, style-agnostic architecture proposal — style choice, component boundaries, integration contracts, and recorded decisions. Use when no architecture yet exists for a requirement and one needs to be designed from scratch, regardless of architectural style (monolith, microservices, event-driven, serverless, etc.).
---

# Architecture from Requirements

Produces an architecture proposal from a requirement. This skill is style-agnostic: it does not
assume microservices, DDD, or any other paradigm up front — the requirement's drivers determine
the style, and heavier tools (like DDD modeling) are invoked only when the style and domain
complexity actually call for them. `architecture-review` is the checker — run this first, then
that.

## When to invoke

- A requirement or `spec-driven-development` spec exists but no architecture proposal does yet
- Scoping a new system, service, or subsystem to satisfy a set of requirements
- Turning a `constitution-to-specs` backlog into a coherent system shape before individual specs
  are implemented
- **Not** for evaluating an architecture that already exists or was already proposed by someone
  else — use `architecture-review` for that instead

## Inputs

- One or more structured requirements (from `requirement-analysis/`) or a spec-driven-development
  spec — the "what" and "why" this architecture must satisfy
- If this is a brownfield addition: the existing architecture documentation and `adr/` directory,
  so the new design fits the current system instead of ignoring it

## Process

Follow in order — each step's output feeds the next. Steps marked *(conditional)* only apply
when the style chosen in step 3 calls for them — do not invoke a heavier tool than the problem
needs.

1. **Ground in prior decisions.** Invoke `adr-reader` to check whether any part of this problem is
   already settled. Do not redesign something an ADR already decided; propose superseding it
   explicitly if it no longer fits.

2. **Extract architecturally significant requirements (ASRs).** Not every requirement drives the
   architecture. Pull out the ones that constrain structure, not just behavior — see table below.

3. **Choose an architectural style**, driven directly by the ASRs from step 2 — see the style
   table below. Write down which ASR forced which style choice; a style with no ASR behind it is
   a guess, not a decision.

4. **Decompose into components.** Regardless of style, name the components/modules/services this
   system needs and give each a single, stated responsibility. *(Conditional)* — if the domain is
   complex enough that naming components requires resolving conflicting terminology or modeling
   business rules explicitly (multiple entities, ubiquitous-language conflicts, several teams
   sharing a domain), invoke `ddd-bounded-context` for structured boundary modeling. For a small
   monolith or a handful of clearly-scoped services, direct decomposition is enough — don't invoke
   it just because it exists.

5. **Define integration between components.** For every pair of components that talk to each
   other, state explicitly *how*: synchronous request/response, async messaging/events, a shared
   library, a batch/file handoff, or (avoid) a shared database. The integration-pattern vocabulary
   in the table below applies regardless of style. *(Conditional)* — if there are three or more
   components with non-trivial integration relationships worth documenting formally (ownership,
   direction, evolution risk), invoke `ddd-context-map` to produce the map. For one or two
   integration points, stating the pattern inline is enough.

6. **Design the contracts.** For each integration point from step 5: if it's a REST API, invoke
   `eng-api-design`. Otherwise (event schema, RPC/gRPC contract, message format, library API)
   define the contract directly, applying the same underlying principles regardless of transport
   — explicit versioning, a documented error/failure semantics, backward compatibility rules, and
   an owner.

7. **Address cross-cutting and deployment concerns** — see checklist below. These apply to every
   style and are easy to skip because no single component owns them.

8. **Record decisions as they're made — not batched at the end.** Each time steps 3–7 produce a
   non-trivial, hard-to-reverse decision (a style choice, a component boundary, an integration
   pattern, a data ownership call), invoke `adr-writer` immediately for that decision. Waiting
   until the end risks losing the reasoning that justified it.

9. **Self-check.** Invoke `architecture-review` against the ADRs just written to catch
   misalignment or missing decisions before handing the proposal off.

## Architecturally significant requirements

| Requirement mentions... | Quality attribute driver | Why it's architectural |
|---|---|---|
| Response time, throughput, load | Performance | Drives sync vs. async, caching, data locality |
| Uptime, failover, disaster recovery | Availability | Drives redundancy, boundary placement, coupling |
| PII, auth, compliance (GDPR, PCI, etc.) | Security | Drives boundary isolation, ACLs, data ownership |
| Multiple teams, independent deploys | Modifiability | Drives component/service boundaries and deploy units |
| Growth in users/data over time | Scalability | Drives partitioning and integration pattern choice |
| Third-party or legacy system dependency | Interoperability | Drives Conformist vs. ACL vs. OHS choice |
| Sporadic/bursty vs. steady load | Cost/operability | Drives serverless vs. always-on deployment |
| Sequential data transformation stages | Throughput/simplicity | Drives pipeline/batch vs. request-driven style |

A requirement that only describes a business rule or a UI flow, with none of the above, usually
belongs entirely inside one component and doesn't need this process — skip straight to
implementation.

## Choosing an architectural style

| Style | Use when the ASRs show... | Main trade-off |
|---|---|---|
| **Layered monolith** | Small team, domain boundaries still unclear, need to ship fast | Simple to build and deploy; risks becoming tangled without internal discipline |
| **Modular monolith** | Natural seams exist in the domain, but per-service deploy overhead isn't justified yet | Keeps single-deploy simplicity while enforcing boundaries in code |
| **Microservices** | Multiple teams need independent deploy cadence, or components have sharply different scaling needs | Operational complexity, distributed-system failure modes, network as a new failure surface |
| **Event-driven** | Components must react to state changes asynchronously and stay decoupled from each other | Eventual consistency; harder to trace one end-to-end flow |
| **Serverless / FaaS** | Load is sporadic/bursty and minimal ops overhead is a stated goal | Cold starts, vendor lock-in, harder local development |
| **Pipeline / batch** | Data moves through discrete sequential transformation stages, latency isn't critical | Not suitable when a requirement demands real-time response |

Styles combine in practice (e.g., a modular monolith that publishes events for one async
workflow) — pick the dominant style per component, not one style for the whole system if the
ASRs don't support that.

## Integration patterns

Applies to any style — these describe the *relationship*, not a specific technology:

| Pattern | Use when |
|---|---|
| **Partnership** | Two teams/components succeed or fail together; coordinate continuously |
| **Shared Kernel** | Components share a small, consciously maintained subset (code, schema, types) |
| **Customer–Supplier** | Upstream provides; downstream consumes (upstream sets the terms) |
| **Conformist** | Downstream accepts upstream's model as-is, no translation |
| **Anti-Corruption Layer** | Downstream translates upstream's model to protect its own |
| **Open Host Service** | Upstream publishes a protocol others consume (REST API, event stream) |
| **Published Language** | Shared, documented interchange format (JSON schema, Protobuf, Avro) |
| **Separate Ways** | No integration; each component solves its own problem independently |

## Cross-cutting and deployment concerns

- [ ] **Data ownership** — every piece of state has exactly one component that owns writes to it
- [ ] **Deployment topology** — how many independently deployable units, and why that number
- [ ] **AuthN/AuthZ boundary** — where identity is established and where authorization is enforced
- [ ] **Observability ownership** — which component's logs/traces/metrics answer "what broke"
- [ ] **Configuration and secrets** — how each component gets its config without hardcoding it

## Output format

- **Drivers** — the ASRs pulled out in step 2, one line each
- **Style** — the chosen architectural style(s) and the ASR that justified each
- **Components** — table: name, responsibility, owning team (if known)
- **Integration** — the pattern per integration point, per the table above
- **Contracts** — summary of the interfaces designed in step 6
- **Cross-cutting concerns** — how each item in the checklist above is addressed
- **ADRs created** — list of ADR numbers/titles produced in step 8
- **Open questions** — anything step 9 flagged as still undecided

## Implementation checklist

- [ ] Every ASR maps to at least one architectural decision, or is explicitly noted as not driving
      one
- [ ] The chosen style is traceable to a specific ASR, not picked by default or by familiarity
- [ ] Every component has a single stated responsibility
- [ ] Every integration between components has a named pattern — no unlabeled "calls" or "talks to"
- [ ] Every non-trivial decision has a corresponding ADR, written at the time it was made
- [ ] Cross-cutting concerns are addressed, not left implicit
- [ ] `architecture-review` has been run against the result and its findings addressed

## Common mistakes

- Defaulting to microservices or full DDD modeling because they're familiar, not because an ASR
  justifies the added operational or conceptual cost
- Jumping straight to contract design before components and their boundaries are settled
- Treating every requirement as architecturally significant, producing a bloated proposal for what
  was really a single-component feature
- Batching all ADRs at the end from memory, losing the specific trade-off reasoning from each
  decision as it was made
- Designing in a vacuum — skipping `adr-reader` and re-deciding something already settled, or
  contradicting it without saying so
- Leaving cross-cutting concerns (data ownership, auth, observability) unaddressed because no
  single component "owns" them
