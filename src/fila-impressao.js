/**
 * A FILA DE IMPRESSÃO do Print Client — pura, sem Electron e sem impressora.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ POR QUE ELA EXISTE (09/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Reclamação da expedição: *"a cada etiqueta que sai tem uma pequena pausa
 * pra iniciar a próxima, não é contínuo"*.
 *
 * Medido no Hub: **99% dos jobs são de UMA etiqueta** (8.606 de 8.676 num dia)
 * e o servidor publicava um a cada ~0,5 s. O gargalo não era o envio — era o
 * que o cliente fazia com cada job: reescrever o PDF, gravar um temporário e
 * **chamar o SumatraPDF**. Criar esse processo, carregar o PDF, falar com o
 * spooler e fechar custa centenas de milissegundos. Por etiqueta.
 *
 * A correção não é "deixar mais rápido": é **parar de fazer N vezes o que
 * pode ser feito uma vez**. As etiquetas de uma rajada viram UM documento de
 * N páginas e UMA chamada à impressora — que é como a térmica imprime em
 * fluxo contínuo.
 *
 * ── As quatro decisões, e o que cada uma impede ────────────────────────────
 *
 * 1. **Agrupamento oportunista, SEM janela de espera.** A fila ociosa dispara
 *    na hora com o que tiver: a etiqueta avulsa (o clique único, caso mais
 *    comum fora da onda) continua instantânea, sem nenhum atraso novo. As que
 *    chegam ENQUANTO o lote imprime se acumulam e saem juntas no ciclo
 *    seguinte. Quanto maior a rajada, maior o lote — e não há temporizador
 *    para calibrar nem latência artificial para explicar depois.
 *
 * 2. **Uma fila por DESTINO** (impressora + tipo + escala). Fila única
 *    serializaria duas impressoras que podiam trabalhar em paralelo; e juntar
 *    escalas diferentes num PDF só é impossível — a escala vale para o
 *    documento inteiro.
 *
 * 3. **Lote que falha é refeito UM A UM.** Um PDF corrompido no meio não pode
 *    derrubar as outras 24 etiquetas; o erro vira ACK só de quem falhou.
 *
 * 4. **ACK sempre, para todo job.** O Hub marca a etiqueta como impressa pelo
 *    ACK; job sem confirmação fica preso na tela do operador para sempre. É a
 *    razão de o `imprimir` nunca poder escapar sem passar por `confirmar`.
 *
 * ⚠️ **A ORDEM é preservada dentro de um destino**: o lote sai na sequência em
 * que os jobs chegaram. A expedição confere o papel contra a lista da tela —
 * etiqueta fora de ordem é pior que etiqueta lenta.
 */

/** Teto de etiquetas por lote — o mesmo `MAX_POR_BLOCO` do servidor. */
const MAX_POR_LOTE = 25;

/** O destino de um job: o que PODE ser impresso na mesma chamada. */
function chaveDoDestino(job) {
  return [
    job.type === 'zpl' ? 'zpl' : 'pdf',
    job.printer_system_name || '',
    job.zpl_host || '',
    job.zpl_port || '',
    job.escala || '',
  ].join('|');
}

/**
 * Cria a fila.
 *
 * @param {object} portas
 * @param {(lote: Array) => Promise<void>} portas.imprimir  recebe os itens do
 *        lote (todos do mesmo destino) e devolve quando o papel foi entregue
 *        à impressora. Lançar = o lote falhou.
 * @param {(item: object, status: string, erro: string|null) => void} portas.confirmar
 * @param {(mensagem: string) => void} [portas.registrar]
 * @param {number} [portas.maxPorLote]
 */
function criarFilaDeImpressao({ imprimir, confirmar, registrar = () => {}, maxPorLote = MAX_POR_LOTE }) {
  /** chave do destino → { pendentes: [], rodando: boolean } */
  const filas = new Map();

  /**
   * Enfileira — recusando o `job_uuid` que JÁ está na fila.
   *
   * ══════════════════════════════════════════════════════════════════════════
   * 🚨 11 ETIQUETAS PARA 6 PEDIDOS (31/10/2026)
   * ══════════════════════════════════════════════════════════════════════════
   * Medido no `print.log` da RDF:
   *
   *   13:52:47 [pull] 6 pendente(s): 5 para imprimir, 1 em DÚVIDA
   *   13:53:06 [zpl] 11 etiqueta(s), 412 KB
   *   13:53:06 [fila] lote de 11 etiqueta(s) em UMA chamada
   *   e 11 ACKs para 6 uuids — cinco repetidos.
   *
   * O MESMO job chegou por DOIS caminhos quase no mesmo instante: o MQTT
   * publicou as 6 e o pull entregou as mesmas 6 (o pull oferece tudo que
   * está sem ACK, e naquele segundo nenhuma tinha ACK ainda). As duas
   * cópias entraram, e o papel saiu em dobro.
   *
   * ⚠️ O registro em disco NÃO barra isto: ele só marca quando a impressão
   * COMEÇA, e aqui as duas cópias entram antes disso. O cabeçalho do
   * `puxarPendentes` já descrevia a janela — *"duas listas iguais em voo
   * enfileirariam o mesmo job duas vezes antes de qualquer impressão"* — e
   * ela ficou latente até alguém medir o papel.
   *
   * ⚠️ Deduplicar por `job_uuid` NÃO atrapalha reimpressão: quando o
   * operador manda imprimir de novo, o Hub cria um job NOVO, com uuid novo.
   * O que se barra aqui é a MESMA entrega chegando duas vezes.
   *
   * ⚠️ O uuid sai do conjunto quando o item tem desfecho (no `despachar`),
   * não quando entra no lote — senão a janela voltaria a existir entre o
   * `splice` e a impressão.
   */
  function enfileirar(job, userId) {
    const chave = chaveDoDestino(job);
    if (!filas.has(chave)) filas.set(chave, { pendentes: [], rodando: false, emCurso: new Set() });
    const fila = filas.get(chave);
    if (!fila.emCurso) fila.emCurso = new Set();

    const uuid = job && job.job_uuid;
    if (uuid) {
      if (fila.emCurso.has(uuid)) {
        registrar(`${uuid} já está na fila — ignorando a segunda entrega (MQTT + pull)`);
        return;
      }
      fila.emCurso.add(uuid);
    }
    fila.pendentes.push({ job, userId });
    return bombear(chave);
  }

  async function bombear(chave) {
    const fila = filas.get(chave);
    if (!fila || fila.rodando) return;
    fila.rodando = true;
    try {
      while (fila.pendentes.length) {
        // Leva TUDO que se acumulou enquanto o lote anterior saía no papel.
        const lote = fila.pendentes.splice(0, maxPorLote);
        await despachar(lote);
      }
    } finally {
      fila.rodando = false;
      /*
       * ⚠️ Chegou job durante o `finally`? O `enfileirar` chamaria `bombear` e
       * encontraria `rodando: true`, e o job ficaria parado até o PRÓXIMO
       * chegar — uma etiqueta presa na fila sem nenhum erro. Esta última
       * olhada fecha a fresta.
       */
      if (fila.pendentes.length) void bombear(chave);
    }
  }

  /** O uuid deixa de ocupar a fila quando o item TEM desfecho. */
  function liberar(lote) {
    for (const fila of filas.values()) {
      if (!fila.emCurso) continue;
      for (const item of lote) {
        const uuid = item && item.job && item.job.job_uuid;
        if (uuid) fila.emCurso.delete(uuid);
      }
    }
  }

  async function despachar(lote) {
    try {
      await imprimir(lote);
      if (lote.length > 1) registrar(`lote de ${lote.length} etiqueta(s) em UMA chamada`);
      for (const item of lote) confirmar(item, 'success', null);
      liberar(lote);
      return;
    } catch (erro) {
      // Lote de um só JÁ é o caso individual: não há o que refazer.
      if (lote.length === 1) {
        confirmar(lote[0], 'error', erro && erro.message ? erro.message : String(erro));
        /*
         * ⚠️ LIBERA também no erro. Sem isto o uuid ficaria ocupando a fila
         * para sempre e a etiqueta nunca mais entraria — trocando a
         * duplicata por uma perda, que é pior.
         */
        liberar(lote);
        return;
      }
      registrar(
        `lote de ${lote.length} falhou (${erro && erro.message ? erro.message : erro}) — refazendo uma a uma`,
      );
    }
    // O erro de uma etiqueta não condena as outras.
    for (const item of lote) await despachar([item]);
  }

  return {
    enfileirar,
    chaveDoDestino,
    /** Só para teste e diagnóstico: quantos jobs esperam em cada destino. */
    pendentes: () => {
      const fora = {};
      for (const [chave, fila] of filas) fora[chave] = fila.pendentes.length;
      return fora;
    },
  };
}

module.exports = { criarFilaDeImpressao, chaveDoDestino, MAX_POR_LOTE };
