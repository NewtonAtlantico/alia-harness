# Tasks: consultar-pedidos

### T2.1 — GET /v1/orders com paginação por cursor

**Slice:** Slice 1 — listar pedidos
**Story points:** 5 pts
**Depends on:** 1.2

**Description**
Endpoint de listagem.

**Acceptance criteria**
- [ ] Retorna 20 pedidos por página

**Out of scope**
Filtros.

### T2.2 — Lista de pedidos na UI

**Slice:** Slice 1 — listar pedidos
**Story points:** 3
**Depends on:** T2.1

**Description**
Tela com a lista.

**Acceptance criteria**
- [ ] A lista pagina ao rolar

**Out of scope**
Exportação.

### T2.3 — Detalhe do pedido

**Slice:** Slice 2 — detalhe
**Story points:** 3
**Depends on:** 2.1

**Description**
Tela de detalhe.

**Acceptance criteria**
- [ ] Mostra itens e status

**Out of scope**
Rastreamento de entrega.
