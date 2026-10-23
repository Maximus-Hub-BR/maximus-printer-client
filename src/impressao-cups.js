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

module.exports = {
  canalDePdf,
  canalDeZpl,
  argumentosDePdf,
  argumentosDeZplRaw,
  interpretarLpstat,
}
