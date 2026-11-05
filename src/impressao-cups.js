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


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RETOMAR A FILA PAUSADA — sem duplicar e sem perder (04/11/2026)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Até aqui, fila pausada virava erro honesto e parava por ali: *"Retome a
 * impressora e mande de novo"*. Funciona, mas joga para quem opera um
 * problema que a máquina sabe resolver — e no incidente de 31/10/2026 isso
 * custou 5 ondas de 21 etiquetas paradas sem ninguém entender por quê.
 *
 * O pedido do dono foi explícito: transparente para quem usa, com **certeza
 * de zero duplicidade e zero perda**. As duas saídas óbvias falham nisso:
 *
 *   · cancelar tudo que está preso → não duplica, mas PERDE o que o Hub já
 *     contou como impresso;
 *   · retomar e deixar sair tudo → não perde, mas DUPLICA o que a operadora
 *     já reimprimiu à mão (o cenário real de 31/10).
 *
 * 🚨 **A saída é não tocar no que é dos outros.** O `lp` devolve o id do
 * trabalho que ACABOU de criar — e era essa saída que a gente jogava fora.
 * Com o id em mãos, a sequência cancela **só o próprio trabalho**, que
 * comprovadamente não saiu, retoma a fila e tenta UMA vez:
 *
 *     id = idDoTrabalhoDoLp(saída do lp)
 *     se a fila está pausada:
 *         cancel <id>        ← só o meu, nunca o de outro
 *         cupsenable <fila>
 *         reconfere e reenvia UMA vez
 *
 * Zero duplicidade porque o único trabalho cancelado é o que eu criei e que
 * não imprimiu. Zero perda porque, se a segunda tentativa também falhar, o
 * erro sobe, o Hub grava `error`, o `print_count` não é incrementado e o
 * pedido **volta para a aba** — medido em 04/11/2026 com a fila pausada de
 * propósito.
 *
 * ⚠️ E o efeito colateral que importa: a partir daqui **deixa de existir**
 * "fila pausada com trabalho preso", porque todo trabalho que encontra a
 * fila pausada é cancelado no mesmo instante. A janela some; sobra só a
 * limpeza única dos trabalhos legados.
 */

/**
 * O id do trabalho que o `lp` acabou de criar, lido do stdout dele.
 *
 * O `lp` responde `request id is <fila>-<n> (1 file(s))` — e em português
 * `id solicitado é <fila>-<n> (1 arquivo(s))`. Por isso o padrão casa a
 * FORMA do id (`fila-número` antes do parêntese), não a frase: procurar o
 * texto em inglês devolve `null` num Mac em português, exatamente como o
 * `lpstat` já ensinou aqui.
 *
 * ⚠️ `null` quando não reconhece — e aí o cancelamento é PULADO. Cancelar
 * sem saber o id significaria `cancel -a`, que derruba trabalho dos outros:
 * é o oposto da garantia que esta função existe para dar.
 */
function idDoTrabalhoDoLp (saidaDoLp) {
  const texto = String(saidaDoLp || '')
  const achado = texto.match(/([A-Za-z0-9_.:@-]+-\d+)\s*\(/)
  return achado ? achado[1] : null
}

/** Argumentos do `cancel` para UM trabalho — nunca `-a`. */
function argumentosDeCancelamento (idDoTrabalho) {
  return [String(idDoTrabalho)]
}

/**
 * Argumentos do `cupsenable` para retomar a fila.
 *
 * ⚠️ `cupsenable` retoma a IMPRESSÃO; `cupsaccept` retoma o ACEITE de novos
 * trabalhos. São coisas diferentes e o sintoma de 31/10 é o primeiro: o
 * `lp` era aceito (logo, o aceite estava ligado) e nada saía.
 */
function argumentosDeRetomada (impressora) {
  return [String(impressora)]
}

module.exports = {
  canalDePdf,
  argumentosDeEstadoDaFila,
  filaEstaPausada,
  canalDeZpl,
  argumentosDePdf,
  argumentosDeZplRaw,
  interpretarLpstat,
  idDoTrabalhoDoLp,
  argumentosDeCancelamento,
  argumentosDeRetomada,
}
