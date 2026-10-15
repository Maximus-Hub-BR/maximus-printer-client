# maximus-printer-client — contexto para quem programa aqui

> 🧠 **Antes de qualquer tarefa, leia o brain**:
> [`Maximus-Hub-BR/maximushub-brain`](https://github.com/Maximus-Hub-BR/maximushub-brain)
> — em especial `dominio/expedicao.md`.

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

## Antes de abrir um PR

- [ ] li o que o brain diz do assunto
- [ ] **commit seletivo** — nunca `git add .`
- [ ] teste **verificado desfazendo**
- [ ] branch pelo git-flow
- [ ] se aprendi algo que não estava escrito: rodei `/aprender`
