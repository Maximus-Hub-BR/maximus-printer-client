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
 * 2. **Uma fila por IMPRESSORA FÍSICA; o LOTE é por destino.** São duas
 *    perguntas diferentes, e durante um ano elas tiveram uma resposta só:
 *
 *      - *quem espera quem?* → a impressora física (fila + host:porta). Duas
 *        impressoras trabalham em paralelo; a MESMA, nunca.
 *      - *o que cabe na mesma chamada?* → o destino (`chaveDoDestino`: tipo,
 *        escala, controle). Juntar escalas diferentes num PDF só é
 *        impossível — a escala vale para o documento inteiro.
 *
 *    🚨 **Fundir as duas custou etiqueta (medido em 23/11/2026).** Enquanto a
 *    fila era indexada por destino, dois jobs para a MESMA impressora com
 *    tipo ou escala diferentes caíam em filas distintas e disparavam `lp`
 *    CONCORRENTE na mesma fila do CUPS. Na bancada, 3 chamadas no mesmo
 *    segundo (~120 KB de ZPL) saíram como **UMA** etiqueta: o CUPS aceitou as
 *    três, a fila ficou vazia e ociosa, e não houve erro em lugar nenhum —
 *    ACEITO ≠ IMPRESSO, sem rastro.
 *
 *    O caminho real que produzia isso já estava documentado em
 *    `backend-novo/src/impressao/destino-do-job.ts`: a bipada do **picking**
 *    imprime SEM `escala` e a onda/avulso COM — mesma impressora da
 *    expedição, duas filas. Bipar um pedido enquanto a onda saía era o
 *    bastante. Irmão do incidente de 06/11/2026 (a onda em dobro), com a
 *    MESMA raiz — "o destino define a fila" — e um estrago diferente: lá a
 *    trava `emCurso` não via a segunda entrega; aqui a impressora recebe duas
 *    conversas ao mesmo tempo.
 *
 *    ⚠️ O lote segue sendo um **prefixo contíguo** de mesma `chaveDoDestino`,
 *    nunca um filtro que varre a fila: a ordem de chegada é a ordem do papel,
 *    e a expedição confere o papel contra a lista da tela.
 *
 * 3. Só falha comprovadamente ANTES do envio pode ser isolada por item.
 *    Falha depois de possível envio é incerta: repetir duplicaria etiquetas.
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

/**
 * A IMPRESSORA FÍSICA de um job — quem espera quem. É a chave da FILA.
 *
 * ⚠️ De propósito NÃO inclui `type`, `escala` nem `controle`: esses dizem o
 * que cabe na mesma chamada (`chaveDoDestino`), não quem compartilha o
 * aparelho. Acrescentar qualquer um deles aqui reabre o `lp` concorrente.
 */
function chaveDaImpressora(job) {
  /*
   * 🚨 A PORTA SÓ EXISTE QUANDO HÁ HOST — e ignorá-la é o que fecha o caso
   * `onda` × `avulso` (23/11/2026).
   *
   * `backend-novo/src/impressao/destino-do-job.ts` manda `zpl_host`/`zpl_port`
   * no avulso e no picking, e NUNCA na onda — decisão consciente de
   * 06/11/2026, registrada lá: *"incluí-los agora juntaria a fila da onda com
   * a do avulso no cliente"*. Resultado prático na mesma Zebra:
   *
   *     onda    → printer_system_name=Zebra, sem host, sem porta
   *     avulso  → printer_system_name=Zebra, host=null, porta=9100
   *
   * Se a porta entrasse na chave, esses dois seriam aparelhos diferentes — e
   * o lote em curso mais um clique em "Imprimir" voltariam a disputar o mesmo
   * `lp`. Mas `zpl_port` SEM `zpl_host` não imprime nada por socket: o
   * cliente só abre conexão quando tem host (e nenhuma das 184 impressoras
   * cadastradas tem). Sem host, o papel sai pelo CUPS, e quem identifica o
   * aparelho é a FILA DO SISTEMA, sozinha.
   */
  const porSocket = job.zpl_host ? `${job.zpl_host}:${job.zpl_port || 9100}` : '';
  return porSocket || `cups:${job.printer_system_name || ''}`;
}

/** O destino de um job: o que PODE ser impresso na mesma chamada. */
function chaveDoDestino(job) {
  const partes = [
    job.type === 'zpl' ? 'zpl' : 'pdf',
    job.printer_system_name || '',
    job.zpl_host || '',
    job.zpl_port || '',
    job.escala || '',
  ];
  if (job.controle?.versao === 1) partes.push('controle-v1');
  return partes.join('|');
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
    const chave = chaveDaImpressora(job);
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
        /*
         * Leva o que se acumulou enquanto o lote anterior saía no papel — mas
         * só enquanto o DESTINO não muda.
         *
         * ⚠️ Prefixo contíguo, não filtro: a fila da impressora pode ter
         * [pdf, zpl, pdf], e varrer por tipo mandaria os dois pdf juntos,
         * pondo a 3ª etiqueta no papel antes da 2ª. A ordem de chegada é a
         * ordem do papel. Destino diferente não é descartado nem adiado: ele
         * é o lote da volta seguinte do laço, imprimindo logo depois.
         */
        const destino = chaveDoDestino(fila.pendentes[0].job);
        let quantos = 1;
        while (
          quantos < maxPorLote &&
          quantos < fila.pendentes.length &&
          chaveDoDestino(fila.pendentes[quantos].job) === destino
        ) quantos += 1;
        const lote = fila.pendentes.splice(0, quantos);
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
      const antes = erro && erro.antesDoEnvio === true;
      const podeIsolar = antes && lote.length > 1 && lote.every(i => !i.job.controle);
      if (!podeIsolar) {
        const prefixo = antes ? 'NAO_ENVIADO:' : 'RESULTADO_INCERTO:';
        const mensagem = `${prefixo} ${erro && erro.message ? erro.message : String(erro)}`;
        for (const item of lote) confirmar(item, 'error', mensagem);
        liberar(lote);
        return;
      }
      registrar(`lote de ${lote.length} falhou antes do envio — isolando documentos`);
    }
    // O erro de uma etiqueta não condena as outras.
    for (const item of lote) await despachar([item]);
  }

  return {
    enfileirar,
    chaveDoDestino,
    chaveDaImpressora,
    /**
     * Há trabalho em curso? (pendente OU já no lote que está imprimindo)
     *
     * ⚠️ `pendentes()` NÃO serve para isso: ele conta só a fila de espera, e
     * o lote em voo já saiu dela pelo `splice`. Quem sabe o conjunto inteiro
     * é o `emCurso`, que só libera no DESFECHO. A diferença decide se o
     * cliente pode se reiniciar para atualizar — e reiniciar no meio de um
     * lote custa etiquetas, que não têm desfazer.
     */
    ocupada: () => {
      for (const fila of filas.values()) {
        if (fila.pendentes.length) return true;
        if (fila.emCurso && fila.emCurso.size) return true;
      }
      return false;
    },

    /** Só para teste e diagnóstico: quantos jobs esperam em cada IMPRESSORA. */
    pendentes: () => {
      const fora = {};
      for (const [chave, fila] of filas) fora[chave] = fila.pendentes.length;
      return fora;
    },
  };
}

module.exports = { criarFilaDeImpressao, chaveDoDestino, chaveDaImpressora, MAX_POR_LOTE };
