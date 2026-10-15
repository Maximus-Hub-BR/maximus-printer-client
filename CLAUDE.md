# maximus-printer-client — contexto para quem programa aqui

**Idioma do projeto: português (pt-BR)**, com acentuação correta.

---

## O que é este repositório

O agente Electron que roda no PC da expedição: recebe o trabalho por MQTT e
manda para a impressora.

---

## 🚨 O que torna este repositório diferente

**Ele roda na máquina de outra pessoa, e se atualiza sozinho.** Não há "fazer
deploy e pronto": uma versão ruim fica instalada até a próxima conseguir
substituí-la.

- O **dono do repositório é cravado no binário** na hora do build — é o
  endereço que o auto-update consulta. Mudar a conta do repositório sem
  publicar versão nova deixa o parque dependendo de redirect.
- O servidor **só manda o formato novo de impressão para versões acima de um
  mínimo**. O auto-update é como o parque evolui sem visitar máquina a máquina.
- **A publicação do instalador é manual** (`workflow_dispatch`): criar tag não
  publica binário.

⚠️ **O envio direto à impressora já falhou em SILÊNCIO três vezes num dia** —
estrutura de dados errada, retorno engolido, e um script achatado numa linha
só. Nenhuma apareceu como erro: a etiqueta saía pelo caminho antigo e o comando
novo simplesmente não chegava. Por isso os testes aqui verificam as
**invariantes estruturais** do comando, não só o resultado feliz.

---

# 🧠 Protocolo de sessão — vale para toda tarefa neste repositório

Estas são **premissas da organização**. Elas não dependem de quem está na
cadeira nem de qual IA está sendo usada.

## 1. No início da sessão — carregar o contexto

O conhecimento do MaximusHub vive em
[`Maximus-Hub-BR/maximushub-brain`](https://github.com/Maximus-Hub-BR/maximushub-brain).
Um hook de `SessionStart` já clona/atualiza o brain automaticamente
(`.claude/hooks/sincronizar-brain.sh`).

**Antes de escrever a primeira linha de código:**

1. leia o **`INDEX.md`** do brain — uma linha por documento;
2. abra **só** os documentos do assunto da tarefa (o índice existe para você
   **não** ler a base inteira);
3. primeira vez no projeto? `COMECE-AQUI.md`, inteiro.

Atalho: a skill **`/contexto`** faz os três passos e diz o que carregou.

⚠️ **Sem isso, o que sai é código plausível que ignora o que custou caro** — e
plausível é justamente o que mais dá trabalho para revisar.

## 2. Ao concluir a tarefa — devolver o aprendizado

Se a tarefa revelou algo que **não estava escrito** — causa raiz, pegadinha de
integração, o porquê de uma decisão, uma medição que muda uma escolha — rode a
skill **`/aprender`**. Ela grava no `inbox/` do brain e empurra.

A consolidação funde o `inbox/` nos documentos definitivos, e na sessão
seguinte **todo o time já começa sabendo**.

⚠️ **Não grave o óbvio.** Se está no código ou no histórico do git, não vale.
Vale a pegadinha, a causa, a medição, o motivo.

⚠️ **Sem este passo a base vira museu em dois meses** — é a parte que depende
de disciplina, e a que mais rende.

## 3. As premissas que não se negociam

| | onde está escrito |
|---|---|
| 🔐 credencial nunca no repositório; produção só aditiva; dry-run antes de escrever | `seguranca/regras.md` |
| `master` é produção e nada entra sem release; `hotfix` sai de `master` | `padroes/git-flow.md` |
| **"deploy ok" não prova que a correção está no ar** — procure o SÍMBOLO | `playbooks/deploy.md` |
| teste **verificado desfazendo** | `padroes/testes.md` |
| **commit seletivo** — `git add <arquivos>`, nunca `git add .` | `padroes/git-flow.md` |
| português com acentuação em UI, comentários e commits | `padroes/codigo-e-comentarios.md` |

## 4. Suas particularidades são bem-vindas — e moram à parte

Este arquivo é **versionado e compartilhado**: ele carrega as premissas da
organização. O que é só seu — atalhos, caminhos da sua máquina, preferência de
ferramenta, apelido de comando — vai em:

| arquivo | escopo | versionado? |
|---|---|---|
| `CLAUDE.md` *(este)* | **a organização** — vale para todo mundo | **sim** |
| `CLAUDE.local.md` | **você, neste repositório** | não (está no `.gitignore`) |
| `~/.claude/CLAUDE.md` | **você, em todos os projetos** | não |
| `.claude/settings.local.json` | suas permissões e hooks locais | não |

**A precedência:** o local **acrescenta**, nunca **revoga**. Se a sua
preferência contraria uma premissa da organização, vale a premissa — e se você
acha que a premissa está errada, o caminho é discutir e mudar o brain, não
contornar em silêncio.

> Exemplo legítimo de `CLAUDE.local.md`: "meu banco local roda na porta 3307",
> "prefiro que você rode os testes com `--silent`", "meu editor é X".
> Exemplo **ilegítimo**: "pode usar `git add .`", "não precisa de teste".

## 5. Checklist antes de abrir um PR

- [ ] carreguei o contexto do brain para o assunto da tarefa
- [ ] **commit seletivo** — `git add <arquivos>`, nunca `git add .`
- [ ] teste **verificado desfazendo** (desfiz a correção e o teste falhou)
- [ ] branch pelo git-flow, e `git log master..<branch>` mostra o TRABALHO
- [ ] se aprendi algo que não estava escrito: rodei **`/aprender`**
