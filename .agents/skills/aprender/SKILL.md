---
name: aprender
description: Grava o que esta sessão aprendeu no maximushub-brain, para o time inteiro receber. Use ao concluir qualquer tarefa que revelou algo não óbvio — causa raiz de um defeito, pegadinha de integração, decisão e o porquê, medição que muda uma escolha.
---

# /aprender — devolver o aprendizado ao time

> A fonte desta skill é `.Codex/skills/aprender/` do **maximushub-brain**.
> Se divergirem, o brain manda.

## Passos

1. **Localize o brain** (primeiro que existir): `$MAXIMUSHUB_BRAIN`,
   `~/Sites/_maximushub-brain`, `~/.maximushub-brain`. Não existe? O hook de
   início de sessão clona — rode `sh .Codex/hooks/sincronizar-brain.sh`.

2. Revise a conversa e separe o que tem valor **duradouro e compartilhável**:
   causa raiz, decisão de arquitetura e o porquê, pegadinha não óbvia,
   procedimento novo, medição que muda uma decisão.

3. **Descarte**:
   - o que se deduz lendo o código ou o histórico do git;
   - detalhe efêmero (nome de branch temporária, caminho de scratch);
   - 🔐 **qualquer valor de credencial** — cite só a *localização*;
   - 🔐 **dado pessoal de comprador**; use o identificador do pedido;
   - 🔐 **IP, caminho de chave, nome de cofre de senha** — o brain é
     compartilhado e descreve infraestrutura por FUNÇÃO.

4. Grave `<brain>/inbox/YYYY-MM-DD-HHMM-<slug>.md`:

   ```markdown
   ---
   data: <ISO com hora>
   autor: <seu nome ou handle>
   area: <nfe | expedicao | catalogo | marketplaces | deploy | frontend | infra | outro>
   repo: <o repositório em que você estava>
   ---

   <os fatos, com DATAS ABSOLUTAS, causa raiz e desfecho quando for incidente>
   ```

5. Commit e push **no brain** (não no repositório de código):
   `git -C <brain> add inbox/ && git -C <brain> commit -m "inbox: <slug>" && git -C <brain> push`

6. Confirme em uma linha o que foi capturado.

## Como escrever

- **Data absoluta sempre.**
- **O número junto da afirmação** — "ficou mais rápido" não ajuda.
- **A causa, não só o sintoma.**
- **O que NÃO funcionou também vale** — evita que o próximo repita a tentativa.

Se a sessão não gerou nada duradouro, diga isso e **não grave nada**.
