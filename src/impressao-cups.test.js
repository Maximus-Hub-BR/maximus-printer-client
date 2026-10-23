/**
 * Teste do caminho CUPS — `node src/impressao-cups.test.js`.
 *
 * O que se prova aqui é o que já quebrou no Windows em silêncio, agora do
 * lado do Mac: comando cru tem de sair cru, e a lista de impressoras não
 * pode depender do idioma do sistema.
 */
const assert = require('assert')
const {
  canalDePdf,
  canalDeZpl,
  argumentosDePdf,
  argumentosDeZplRaw,
  interpretarLpstat,
} = require('./impressao-cups')

let passaram = 0
const casos = []
const teste = (nome, fn) => casos.push([nome, fn])

teste('PDF no Mac não usa o Sumatra', () => {
  assert.strictEqual(canalDePdf('darwin'), 'cups')
  assert.strictEqual(canalDePdf('linux'), 'cups')
  assert.strictEqual(canalDePdf('win32'), 'sumatra')
})

teste('ZPL com IP continua no socket, em qualquer sistema', () => {
  assert.strictEqual(canalDeZpl('darwin', '192.168.0.20'), 'tcp')
  assert.strictEqual(canalDeZpl('win32', '192.168.0.20'), 'tcp')
})

teste('ZPL local no Mac vai cru para o CUPS; no Windows continua no spooler', () => {
  assert.strictEqual(canalDeZpl('darwin', null), 'cups-raw')
  assert.strictEqual(canalDeZpl('darwin', ''), 'cups-raw')
  assert.strictEqual(canalDeZpl('win32', null), 'winspool')
})

teste('PDF em tamanho real pede scaling=100, e o nome da fila é um argumento só', () => {
  assert.deepStrictEqual(
    argumentosDePdf({
      impressora: 'HP LaserJet "Copiar 1"',
      arquivo: '/tmp/etiqueta 1.pdf',
      escala: 'noscale',
    }),
    ['-o', 'scaling=100', '-d', 'HP LaserJet "Copiar 1"', '/tmp/etiqueta 1.pdf']
  )
})

teste('fit pede fit-to-page; shrink não inventa opção', () => {
  assert.deepStrictEqual(
    argumentosDePdf({ impressora: 'Fila', arquivo: '/tmp/a.pdf', escala: 'fit' }),
    ['-o', 'fit-to-page', '-d', 'Fila', '/tmp/a.pdf']
  )
  assert.deepStrictEqual(
    argumentosDePdf({ impressora: 'Fila', arquivo: '/tmp/a.pdf', escala: 'shrink' }),
    ['-d', 'Fila', '/tmp/a.pdf']
  )
})

teste('ZPL local leva -o raw — sem isso o CUPS desenha o comando como texto', () => {
  const args = argumentosDeZplRaw({ impressora: 'ZDesigner_GC420t', arquivo: '/tmp/e.zpl' })
  assert.deepStrictEqual(args, ['-o', 'raw', '-d', 'ZDesigner_GC420t', '/tmp/e.zpl'])
  assert.ok(args.includes('raw'))
})

teste('lpstat em português e em inglês devolvem o nome da fila', () => {
  const saida = [
    'HP_Color_LaserJet_Pro_4203 aceitando solicitações desde Fri Oct 16 08:58:35 2026',
    'Zebra_ZD220 accepting requests since Mon Oct 20 10:00:00 2026',
    '',
  ].join('\n')
  assert.deepStrictEqual(interpretarLpstat(saida), [
    'HP_Color_LaserJet_Pro_4203',
    'Zebra_ZD220',
  ])
})

teste('mensagem de erro do lpstat não vira impressora', () => {
  assert.deepStrictEqual(interpretarLpstat('lpstat: No destinations added.\n'), [])
  assert.deepStrictEqual(interpretarLpstat(''), [])
  assert.deepStrictEqual(interpretarLpstat(null), [])
})

for (const [nome, fn] of casos) {
  try {
    fn()
    passaram++
    console.log('ok', nome)
  } catch (e) {
    console.error('FALHOU', nome)
    console.error(e)
    process.exit(1)
  }
}
console.log(`${passaram} testes`)
