/**
 * Impressão pelo CUPS — o caminho do macOS (e o fallback de Linux).
 *
 * O `pdf-to-printer` carrega em qualquer sistema e só estoura na hora de
 * imprimir ("Operating System not supported"). Se o `require` tiver sucesso,
 * o ramo do `lp` nunca rodava: no Mac a etiqueta falhava com a frase do
 * Windows.
 *
 * ⚠️ **ZPL local precisa de `-o raw`.** É a mesma lição do `pDatatype =
 * "RAW"` no spooler do Windows: sem isso o CUPS passa o arquivo pelo filtro
 * do driver e os bytes do `^XA` saem impressos como texto, ou somem. O
 * comando tem de ser interpretado pela impressora, não desenhado.
 *
 * ⚠️ **`lpstat` traduz a frase.** Nesta máquina a linha é "aceitando
 * solicitações desde …", não "accepting requests". O nome da fila é o
 * primeiro token — é o que o `lp -d` aceita. Procurar a palavra em inglês
 * devolve lista vazia num Mac em português, e a tela de impressoras abre
 * em branco sem erro.
 */

function canalDePdf (plataforma) {
  return plataforma === 'win32' ? 'sumatra' : 'cups'
}

function canalDeZpl (plataforma, host) {
  if (host) return 'tcp'
  return plataforma === 'win32' ? 'winspool' : 'cups-raw'
}

/**
 * Argumentos do `lp` para um PDF. Cada valor é um argv separado: nome de
 * impressora com espaço ou aspas não pode ir interpolado num shell.
 *
 * `noscale` pede 100% — a etiqueta de marketplace já foi reescrita no
 * tamanho do papel antes de chegar aqui. `fit` pede para caber na página
 * configurada na fila. `shrink` não tem opção equivalente no CUPS; sai sem
 * argumento, como já saía.
 */
function argumentosDePdf ({ impressora, arquivo, escala }) {
  const args = []
  if (escala === 'fit') args.push('-o', 'fit-to-page')
  else if (escala === 'noscale') args.push('-o', 'scaling=100')
  args.push('-d', impressora, arquivo)
  return args
}

/** ZPL cru para a fila local. `-o raw` é obrigatório — ver o cabeçalho. */
function argumentosDeZplRaw ({ impressora, arquivo }) {
  return ['-o', 'raw', '-d', impressora, arquivo]
}

function interpretarLpstat (saida) {
  const nomes = []
  for (const linha of String(saida || '').split('\n')) {
    const partes = linha.trim().split(/\s+/)
    if (partes.length < 2) continue
    const nome = partes[0]
    if (!nome || nome.endsWith(':')) continue
    nomes.push(nome)
  }
  return nomes
}

/**
 * Argumentos do `lpstat` para perguntar o estado de UMA fila.
 *
 * ⚠️ `-p <fila>` e não `-p` sozinho: numa máquina com 16 filas, perguntar por
 * todas custa segundos e ainda traz o estado de quem não interessa.
 */
function argumentosDeEstadoDaFila (impressora) {
  return ['-p', impressora]
}

/**
 * A fila está PAUSADA? (o `lp` aceitou, mas nada vai sair)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 O ACK DIZIA SUCESSO COM 5 LOTES PARADOS NA FILA (31/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Caso real, medido no Hub: a operadora de um Mac mandou a mesma onda de 21
 * etiquetas CINCO vezes porque nada saía. Do lado do Hub, as 5 estavam
 * `success` com ACK em 0-1 s — porque o `lp` ENFILEIRA e volta na hora, e o
 * ACK foi dado sobre isso. A fila do CUPS estava pausada, e o macOS pausa a
 * fila inteira quando um trabalho falha no backend: tudo que chega depois
 * espera, inclusive etiqueta boa. Só um clique em "retomar" liberou.
 *
 * Enquanto isso o Hub mostrava tudo verde e ela olhava a impressora parada.
 * É a mesma classe de defeito que este projeto passou dois dias caçando —
 * perda que não aparece em lugar nenhum — só num lugar que ninguém tinha
 * olhado: DEPOIS da entrega.
 *
 * ⚠️ A frase é TRADUZIDA: num Mac em português a linha é
 * `impressora X desativada desde ...`; em inglês, `printer X disabled
 * since ...`. Medido no `lpstat -p` deste Mac:
 *   impressora HP_Color_LaserJet_Pro_4203 está ociosa.  ativada desde ...
 *   impressora HP_LaserJet_Professional_P_1102w desativada desde ... -
 *
 * ⚠️ `\b` em volta de `desativada` é o que impede casar com `ativada`, que
 * aparece justamente na linha de quem está SAUDÁVEL.
 *
 * ⚠️ **Falha ABERTA**: saída vazia, erro do `lpstat` ou frase que não
 * reconhecemos devolvem `false`. Marcar erro por não entender a saída faria
 * etiqueta boa virar pendência — e o estado "não sei" nunca deve acusar.
 */
function filaEstaPausada (saidaDoLpstat) {
  const texto = String(saidaDoLpstat || '')
  if (!texto.trim()) return false
  return /\bdesativada\b/i.test(texto) || /\bdisabled\b/i.test(texto)
}

module.exports = {
  canalDePdf,
  argumentosDeEstadoDaFila,
  filaEstaPausada,
  canalDeZpl,
  argumentosDePdf,
  argumentosDeZplRaw,
  interpretarLpstat,
}
