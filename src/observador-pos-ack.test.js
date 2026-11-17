/**
 * Teste do observador pós-ACK — `node --test src/observador-pos-ack.test.js`.
 *
 * Sem Electron, sem impressora, sem relógio de verdade: as olhadas são
 * disparadas à mão pelo `agendar` injetado. O que se prova é a REGRA:
 * prova contrária desmente UMA vez; "não sei" nunca desmente; e o desmentido
 * jamais nasce de fila vazia — porque fila vazia é o desfecho normal.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { criarObservadorPosAck, evidenciaContraria, interpretarLeituraWindows } = require('./observador-pos-ack')

function montar ({ respostas }) {
  const agendados = []
  const relatos = []
  const registros = []
  let chamada = 0
  const observador = criarObservadorPosAck({
    consultar: async () => {
      const r = respostas[Math.min(chamada, respostas.length - 1)]
      chamada += 1
      if (r instanceof Error) throw r
      return r
    },
    relatar: (jobUuid, userId, motivo) => relatos.push({ jobUuid, userId, motivo }),
    registrar: (m) => registros.push(m),
    prazosMs: [1, 2],
    agendar: (fn) => { agendados.push(fn); return { unref: () => {} } },
  })
  const disparar = async () => { for (const fn of agendados.splice(0)) await fn() }
  return { observador, relatos, registros, disparar }
}

test('prova contrária na primeira olhada desmente uma única vez', async () => {
  const { observador, relatos, disparar } = montar({
    respostas: [{ evidencia: 'fila pausada com trabalho preso apos o ACK' }],
  })
  observador.observar({ jobUuid: 'j1', userId: 11, destino: {} })
  await disparar()
  assert.equal(relatos.length, 1)
  assert.equal(relatos[0].jobUuid, 'j1')
  assert.match(relatos[0].motivo, /pausada/)
})

test('fila saudável nas duas olhadas não desmente nada', async () => {
  const { observador, relatos, disparar } = montar({ respostas: [{ evidencia: null }] })
  observador.observar({ jobUuid: 'j2', userId: 11, destino: {} })
  await disparar()
  assert.equal(relatos.length, 0)
})

test('consulta que falha é "não sei", nunca desmentido (falha aberta)', async () => {
  const { observador, relatos, registros, disparar } = montar({
    respostas: [new Error('lpstat não respondeu')],
  })
  observador.observar({ jobUuid: 'j3', userId: 11, destino: {} })
  await disparar()
  assert.equal(relatos.length, 0)
  assert.ok(registros.some((m) => m.includes('não concluiu')))
})

test('a segunda olhada pega o que a primeira não viu — e ainda é um só relato', async () => {
  const { observador, relatos, disparar } = montar({
    respostas: [
      { evidencia: null },
      { evidencia: 'impressora reportando erro com trabalho preso apos o ACK' },
    ],
  })
  observador.observar({ jobUuid: 'j4', userId: 11, destino: {} })
  await disparar()
  assert.equal(relatos.length, 1)
  assert.match(relatos[0].motivo, /erro/)
})

test('o mesmo job observado duas vezes não dobra as olhadas nem os relatos', async () => {
  const { observador, relatos, disparar } = montar({
    respostas: [{ evidencia: 'fila pausada com trabalho preso apos o ACK' }],
  })
  observador.observar({ jobUuid: 'j5', userId: 11, destino: {} })
  observador.observar({ jobUuid: 'j5', userId: 11, destino: {} })
  await disparar()
  await disparar()
  assert.equal(relatos.length, 1)
})

test('relatar que lança não derruba o observador', async () => {
  const relatos = []
  const agendados = []
  const observador = criarObservadorPosAck({
    consultar: async () => ({ evidencia: 'fila pausada com trabalho preso apos o ACK' }),
    relatar: () => { relatos.push(1); throw new Error('mqtt caiu') },
    prazosMs: [1],
    agendar: (fn) => { agendados.push(fn); return { unref: () => {} } },
  })
  observador.observar({ jobUuid: 'j6', userId: 11, destino: {} })
  for (const fn of agendados.splice(0)) await fn()
  assert.equal(relatos.length, 1)
})

test('a régua da evidência: só trabalho PRESO desmente', () => {
  // Fila vazia é o desfecho normal — pausa ou erro SEM trabalho não desmente.
  assert.equal(evidenciaContraria({ pausada: true, comProblema: false, comTrabalho: false }), null)
  assert.equal(evidenciaContraria({ pausada: false, comProblema: true, comTrabalho: null }), null)
  // Não sei se há trabalho → não sei (falha aberta).
  assert.equal(evidenciaContraria({ pausada: true, comProblema: true, comTrabalho: null }), null)
  // Trabalho preso + pausa ou erro → prova contrária.
  assert.match(evidenciaContraria({ pausada: true, comProblema: false, comTrabalho: true }), /pausada/)
  assert.match(evidenciaContraria({ pausada: false, comProblema: true, comTrabalho: true }), /erro/)
  // Trabalho na fila com tudo saudável: fila apenas ocupada, não é prova.
  assert.equal(evidenciaContraria({ pausada: false, comProblema: false, comTrabalho: true }), null)
})

test('a leitura do Windows: PaperOut com trabalho preso é prova; Deleting não é', () => {
  // Impressora em PaperOut com 25 jobs presos → prova contrária.
  const papel = interpretarLeituraWindows('PaperOut|25|Printing;Error')
  assert.match(evidenciaContraria(papel), /erro/)
  // Fila pausada com trabalho → prova contrária.
  const pausa = interpretarLeituraWindows('Paused|3|Paused')
  assert.match(evidenciaContraria(pausa), /pausada/)
  // Normal imprimindo → nada.
  assert.equal(evidenciaContraria(interpretarLeituraWindows('Normal|2|Printing')), null)
  // Fila vazia → nada (desfecho normal), mesmo com status estranho.
  assert.equal(evidenciaContraria(interpretarLeituraWindows('Normal|0|')), null)
  // Cancelamento em curso NÃO é prova: sumir da fila é invisível mesmo.
  assert.equal(evidenciaContraria(interpretarLeituraWindows('Normal|1|Deleting')), null)
  // Linha que não entendemos → não sei → nada (falha aberta).
  assert.equal(evidenciaContraria(interpretarLeituraWindows('lixo')), null)
  assert.equal(evidenciaContraria(interpretarLeituraWindows('')), null)
})
