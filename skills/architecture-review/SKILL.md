---
name: architecture-review
description: Review a proposed or existing architecture for soundness and alignment with ADRs
---

# Architecture Review

Review an architectural proposal or existing system architecture.

## Before reviewing

1. Invoke `adr-reader` to load relevant ADRs using the token-efficient cascade protocol
   (INDEX → headers of candidates → full body only if needed)
2. Understand the bounded contexts and their boundaries from the ADRs and code structure

## What to evaluate

1. **Alignment with decisions** — does the architecture follow existing ADRs?
2. **Boundaries** — are responsibilities clearly separated?
3. **Dependencies** — are dependency directions intentional and documented?
4. **Scalability concerns** — are there obvious bottlenecks for the stated scale?
5. **Missing decisions** — are there open architectural questions that should become ADRs?

## Output format

- Summary of what was reviewed
- Findings (aligned / misaligned / unclear) per ADR
- Open questions that should become ADRs
- Recommendation: approve | approve with notes | needs revision
