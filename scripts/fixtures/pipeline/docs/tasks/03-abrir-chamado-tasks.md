# Tasks: abrir-chamado

### Task 3.1: POST /v1/tickets com Idempotency-Key

**Slice:** Slice 1 — abrir chamado ponta a ponta
**Story points:** 5
**Depends on:** 1.2

**Description**
Criação idempotente de chamados.

**Acceptance criteria**
- [ ] Reenviar a mesma requisição não duplica o chamado

**Out of scope**
Anexos.

### Task 3.2: Formulário de chamado

**Slice:** Slice 1 — abrir chamado ponta a ponta
**Story points:** 3
**Depends on:** 3.1

**Description**
Formulário de assunto e descrição.

**Acceptance criteria**
- [ ] Valida campos obrigatórios

**Out of scope**
Chat com o atendente.

### Task 3.3: E-mail de confirmação e notificação

**Slice:** Slice 2 — confirmação
**Story points:** 2
**Depends on:** 3.1, Formulário de chamado

**Description**
Envia o e-mail ao abrir.

**Acceptance criteria**
- [ ] O cliente recebe a confirmação

**Out of scope**
SLA.
