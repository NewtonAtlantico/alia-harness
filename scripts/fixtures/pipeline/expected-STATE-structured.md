# Pipeline state
**Last updated:** 2026-11-18
**Project:** Portal do cliente

_Generated from `docs/pipeline/state.json`. Change the state through the `pipeline_state` tool, not by editing this file._

## Inputs
| # | Name / version | Kind | Handled by | Notes |
|---|---|---|---|---|
| | _none recorded_ | | | |

## Stages
| Stage | Skill | Status | Artifact | Gate |
|---|---|---|---|---|
| 1 | requirement-extraction-from-documents | pending | docs/requirements/requirements.md | G1: pending |
| 2 | architecture-from-requirements | pending | docs/architecture/architecture.md | G2: pending |
| 3 | constitution-to-specs | pending | docs/specs/INDEX.md | G3: pending |
| 4 | spec-to-tasks | pending | docs/tasks/ | — |

## Decisions & answered questions
| Question | Answer | By | Date |
|---|---|---|---|
| _none yet_ | | | |

## Assumptions carried forward
| Assumption | Owner | Stage introduced |
|---|---|---|
| _none_ | | |

## Architecture
**Style:** Monólito modular
**Driver:** Time pequeno e prazo curto
**Review recommendation:** approve with notes
**Notes:** Definir o dono dos logs

| Context | Responsibility |
|---|---|
| Acesso | Login e perfis |
| Pedidos \| histórico | Consulta |

## ADR alignment
| ADR | Alignment | Note |
|---|---|---|
| ADR-0001 | aligned |  |
| ADR-0003 | misaligned | O CRM é dono das gravações de cliente |

## Specs
| Spec | Title | Persona | Depends on | Constraints |
|---|---|---|---|---|
| login-sso | Login com SSO | Cliente corporativo | — | LGPD; WCAG AA |
| consultar-pedidos | Consultar pedidos | Cliente | login-sso |  |

## Spec review (gate 3)
| Spec | Status | By | Date |
|---|---|---|---|
| login-sso | reviewed | Newton | 2026-11-18 |
| consultar-pedidos | draft |  |  |
