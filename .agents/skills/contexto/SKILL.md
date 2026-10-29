---
name: contexto
description: Carrega o contexto do MaximusHub a partir do maximushub-brain antes de começar uma tarefa, e consolida o inbox quando pedido. Use ao iniciar qualquer trabalho — e sempre que a tarefa tocar NF-e, estoque, expedição, deploy ou integração de marketplace.
---

# /contexto — ficar na mesma página antes de agir

> A fonte desta skill é `.Codex/skills/consultar/` do **maximushub-brain**.

## Carregar o contexto

1. **Localize o brain** e garanta que está atualizado:
   `sh .Codex/hooks/sincronizar-brain.sh`

2. Leia o **`INDEX.md`** do brain — uma linha por documento, para você não ler
   a base inteira.

3. Abra **só** o que for do assunto da tarefa:

   | a tarefa toca… | leia no brain |
   |---|---|
   | primeira vez no projeto | `COMECE-AQUI.md` |
   | publicar | `playbooks/deploy.md`, `padroes/git-flow.md` |
   | nota fiscal | `dominio/nfe.md` |
   | estoque, catálogo, kit | `dominio/catalogo-e-estoque.md` |
   | envio, etiqueta, impressão | `dominio/expedicao.md` |
   | integração de praça | `dominio/marketplaces.md` |
   | produção (consulta ou escrita) | `seguranca/regras.md`, `playbooks/consultar-producao.md` |
   | tela nova | `padroes/design-system.md`, `dominio/multi-tenant.md` |

4. Se a tarefa é sobre um defeito, procure em `incidentes/` **antes** de
   investigar do zero — pode já ter acontecido.

5. Diga em uma linha o que carregou, para quem acompanha saber em que base
   você está.

## Consolidar o inbox

Quando pedido, ou quando o `inbox/` acumular:

1. leia cada arquivo de `<brain>/inbox/`;
2. **funda** cada item no documento definitivo (`dominio/`, `padroes/`,
   `playbooks/`, `arquitetura/`, `seguranca/`) — editando o documento, não
   empilhando no fim. Incidente vira arquivo em `incidentes/`;
3. atualize o `INDEX.md` (uma linha por documento);
4. remova do `inbox/` o que foi consolidado;
5. commit no brain: `brain: consolida <n> item(ns) do inbox`.

⚠️ **Fundir, não acumular.** Documento que cresce por empilhamento vira log que
ninguém lê. Informação nova que contradiz a antiga **corrige a antiga**, dizendo
desde quando mudou.
