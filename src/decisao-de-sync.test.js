'use strict'

const test = require('node:test')
const assert = require('node:assert')
const {
  INTERVALO_MINIMO_DE_SYNC_MS,
  listaPodeSerPublicada,
  podeSincronizarAgora,
} = require('./decisao-de-sync')

test('🚨 descoberta que FALHOU (null) nunca é publicada', () => {
  assert.equal(listaPodeSerPublicada(null), false)
  assert.equal(listaPodeSerPublicada(undefined), false)
})

test('lista VAZIA de verdade é publicável — um PC pode não ter impressora', () => {
  // A diferença entre `[]` e `null` é a diferença entre "não tem" e "não
  // consegui perguntar". Quem apara o estrago de um `[]` legítimo é o
  // servidor (recorte-do-sync-de-impressoras.ts), não este módulo.
  assert.equal(listaPodeSerPublicada([]), true)
  assert.equal(listaPodeSerPublicada([{ system_name: 'ZD220' }]), true)
})

test('o primeiro sync sempre passa', () => {
  assert.equal(podeSincronizarAgora({ agora: 1_000, ultimoSyncEm: 0 }), true)
})

test('🚨 rajada de reconexão NÃO vira rajada de sync', () => {
  const inicio = 1_000_000
  // As ~20 reconexões de 5 em 5 s medidas no agente 33 em 30/10/2026.
  for (let i = 1; i <= 20; i++) {
    assert.equal(
      podeSincronizarAgora({ agora: inicio + i * 5_000, ultimoSyncEm: inicio }),
      false,
      `a reconexão ${i} não pode sincronizar`,
    )
  }
})

test('passado o intervalo, sincroniza de novo', () => {
  const inicio = 1_000_000
  assert.equal(
    podeSincronizarAgora({ agora: inicio + INTERVALO_MINIMO_DE_SYNC_MS, ultimoSyncEm: inicio }),
    true,
  )
})

test('o clique humano no Salvar passa por cima do intervalo', () => {
  assert.equal(
    podeSincronizarAgora({ agora: 1_001, ultimoSyncEm: 1_000, forcar: true }),
    true,
  )
})
