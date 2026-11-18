# Tasks: login-sso

Source spec: docs/specs/login-sso-spec.md

### 1.1 Configurar cliente OIDC

**Slice:** Slice 1 — login corporativo ponta a ponta
**Story points:** 3
**Depends on:** none

**Description**
Registrar o cliente OIDC do portal no provedor de identidade e expor a configuração.

**Acceptance criteria**
- [ ] O cliente é registrado com os redirect URIs do ambiente
- [ ] A configuração é lida de variáveis de ambiente

**Out of scope**
Login social.

### 1.2 Fluxo de login e callback

**Slice:** Slice 1 — login corporativo ponta a ponta
**Story points:** 5
**Depends on:** 1.1

**Description**
Implementar o redirecionamento ao provedor e o tratamento do callback.

**Acceptance criteria**
- [ ] Um usuário autenticado chega à página inicial

Exemplo de formato (não é uma tarefa):

```markdown
### 9.9 Isto está dentro de um bloco de código

**Story points:** 99
```

**Out of scope**
Recuperação de senha.

### 1.3 Sessão e logout

**Slice:** Slice 2 — ciclo de vida da sessão
**Story points:** 3
**Depends on:** 1.2

**Description**
Sessão com expiração e logout.

**Acceptance criteria**
- [ ] A sessão expira após o tempo configurado
- [ ] O logout encerra a sessão no provedor

**Out of scope**
Single logout entre aplicações.
