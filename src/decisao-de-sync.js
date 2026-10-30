'use strict'

/**
 * Quando o sync de impressoras pode ir ao servidor — e o que ele nunca pode
 * mandar.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 POR QUE ISTO É UM MÓDULO, E NÃO UM `if` NO main.js (30/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * O `POST print-agents/:uuid/printers` é a ÚNICA chamada do Print Client que
 * apaga dado do Hub. Em 30/10/2026 ela apagou as 4 impressoras do agente 33
 * (`vaio77`, user 56) e a recriação devolveu tudo zerado — inclusive o
 * `shared_with_account` da ZD220, que não tem tela para religar.
 *
 * As duas decisões que impedem a repetição são regra, não acaso, e por isso
 * moram aqui com teste:
 *
 *  - **lista inexistente não é lista vazia.** `descobrirImpressoras` devolve
 *    `null` quando não conseguiu perguntar ao SO (timeout do `Get-Printer`,
 *    spooler subindo depois do boot, saída que não faz `JSON.parse`).
 *    Mandar isso como `[]` é mandar "este PC não tem impressora nenhuma";
 *  - **reconexão de rede não é mudança de hardware.** O sync dispara no
 *    `connect` do MQTT, que se repete a cada 5 s enquanto houver
 *    instabilidade. Um intervalo mínimo transforma uma rajada de 20
 *    reconexões em 1 sync.
 *
 * O clique humano no "Salvar" passa por cima do intervalo (`forcar`): ali a
 * pessoa acabou de instalar uma impressora e espera vê-la.
 */

const INTERVALO_MINIMO_DE_SYNC_MS = 5 * 60 * 1000

/** A lista descoberta pode ser publicada? `null` = a descoberta falhou. */
function listaPodeSerPublicada (printers) {
  return Array.isArray(printers)
}

/**
 * @param {{agora:number, ultimoSyncEm:number, forcar?:boolean, intervaloMs?:number}} e
 */
function podeSincronizarAgora ({ agora, ultimoSyncEm, forcar = false, intervaloMs = INTERVALO_MINIMO_DE_SYNC_MS }) {
  if (forcar) return true
  // ⚠️ "nunca sincronizou" é caso EXPLÍCITO, não consequência de `agora`
  // ser um número grande: o primeiro connect depois de abrir o app precisa
  // sincronizar mesmo que o app tenha acabado de subir.
  if (!ultimoSyncEm) return true
  return agora - ultimoSyncEm >= intervaloMs
}

module.exports = {
  INTERVALO_MINIMO_DE_SYNC_MS,
  listaPodeSerPublicada,
  podeSincronizarAgora,
}
