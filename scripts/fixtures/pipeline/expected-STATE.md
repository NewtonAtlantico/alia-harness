# Pipeline state
**Last updated:** 2026-11-18
**Project:** Portal do cliente

_Generated from `docs/pipeline/state.json`. Change the state through the `pipeline_state` tool, not by editing this file._

## Inputs
| # | Name / version | Kind | Handled by | Notes |
|---|---|---|---|---|
| 1 | BRD_PortalCliente_v2.pdf (v2) | document | requirement-extraction-from-documents |  |
| 2 | kickoff-transcricao.txt | transcript | requirement-extraction-from-threads |  |
| 3 | pedido-diretoria.txt | brief | ticket-to-brief |  |
| 4 | reuniao-kickoff.mp4 | recording |  | Gravações não podem ser lidas. Envie a transcrição. |

## Stages
| Stage | Skill | Status | Artifact | Gate |
|---|---|---|---|---|
| 1 | requirement-extraction-from-documents | done | docs/requirements/requirements.md | G1: passed (5 of 5 answered, 2 deferred) |
| 2 | architecture-from-requirements | done | docs/architecture/architecture.md | G2: passed (1 of 1 answered) |
| 3 | constitution-to-specs | done | docs/specs/INDEX.md | G3: passed |
| 4 | spec-to-tasks | done | docs/tasks/ (11 tasks, 45 points) | — |

## Decisions & answered questions
| Question | Answer | By | Date |
|---|---|---|---|
| Qual versão do BRD é a oficial? | v2 | Newton | 2026-11-18 |
| Parceiros externos usam o portal? | Sim, a partir da fase 2 | Newton | 2026-11-18 |
| O BRD v2 (p. 14) exige SSO \| o kickoff (12:40) fala em login por e-mail. Qual vale? | SSO corporativo desde o início | Newton | 2026-11-18 |
| A proposta grava dados de cliente no portal, mas o ADR-0003 diz que o CRM é dono. Quem é dono das gravações? | O CRM continua dono; o portal usa uma camada anticorrupção | Newton | 2026-11-18 |

## Assumptions carried forward
| Assumption | Owner | Stage introduced |
|---|---|---|
| Integração com o ERP fica fora do MVP | Newton | 1 |
| Volume de usuários simultâneos a confirmar com o cliente | Newton | 1 |
| Dono dos logs e traces do portal a definir | Newton | 2 |

## Spec review (gate 3)
| Spec | Status | By | Date |
|---|---|---|---|
| login-sso | reviewed | Newton | 2026-11-18 |
| consultar-pedidos | reviewed | Newton | 2026-11-18 |
| abrir-chamado | reviewed | Newton | 2026-11-18 |
| acesso-parceiros | reviewed | Newton | 2026-11-18 |

## ADRs
| Id | Title | Status |
|---|---|---|
| ADR-0007 | Estilo: monólito modular | Proposed |
| ADR-0008 | Autenticação via SSO corporativo (OIDC) | Proposed |
| ADR-0009 | Camada anticorrupção para o CRM | Proposed |

## Notes
- Pipeline concluído em uma única conversa.
