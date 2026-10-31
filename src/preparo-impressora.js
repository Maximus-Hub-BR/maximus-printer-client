/**
 * PREPARO DA IMPRESSORA — os comandos ZPL que tiram a pausa entre etiquetas.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * O PROBLEMA, DESCRITO POR QUEM OPERA (09/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * *"Imprime 1 etiqueta, a impressora parece que recalibra a posição e depois
 * imprime a nova."*
 *
 * Esse vai-e-volta é o **backfeed**. Em modo Tear-Off a Zebra avança a
 * etiqueta até a barra de destaque quando termina e **recua** antes da
 * próxima, para posicionar o início da impressão. Custa ~0,5–1,5 s POR
 * ETIQUETA e é mecânico: acontece por mais rápido que o software entregue.
 *
 * Foi por isso que agrupar os jobs (`fila-impressao.js`) deixou o software
 * 7,8× mais rápido — 26 etiquetas entregues em 4,3 s — e a expedição não viu
 * diferença no papel: a impressora leva ~40 s para cuspir as mesmas 26.
 *
 * ⚠️ **Enviar a configuração evita mexer em máquina por máquina.** Um SaaS
 * não pode pedir que cada cliente configure a própria impressora — a
 * alternativa manual ("Post-Print Action: None") foi procurada no driver da
 * expedição e **nem existe lá**.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ A SEGUNDA CAUSA, DOCUMENTADA PELA ZEBRA (09/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Depois de o backfeed não explicar tudo, a busca na base da Zebra achou o
 * sintoma descrito palavra por palavra: *"long delay before jobs print or
 * between print jobs"* em impressora USB no Windows — e a causa é um
 * **problema de temporização entre o tratamento USB do Windows e o Zebra
 * Language Monitor** do pacote de driver. A correção que eles indicam é
 * **desligar o suporte BIDIRECIONAL** da fila de impressão.
 *
 * Isso não é configuração da IMPRESSORA, é da fila do WINDOWS — e
 * `Win32_Printer.EnableBIDI` é gravável por WMI. Dá para fazer daqui, sem
 * ninguém abrir tela nenhuma, que é o que um SaaS precisa.
 *
 * ⚠️ O preço é real e está aceito: sem bidirecional o Windows deixa de ler
 * status da impressora (sem papel, tampa aberta). O Hub nunca usou esse
 * status — quem confirma impressão aqui é o ACK do próprio job.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ AS TRÊS REGRAS QUE ESTE ARQUIVO SEGUE (e por que cada uma existe)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **1. Só para impressora térmica, e na LINGUAGEM certa.** Mandar `~JSO` para
 * uma laser comum IMPRIME O TEXTO "~JSO" numa folha. A detecção é pelo nome e
 * é deliberadamente conservadora: na dúvida, não manda.
 *
 * ⚠️ **E a linguagem importa tanto quanto o modelo** (09/10/2026). A 1.0.5
 * mandou `~JSO` e a pausa continuou: a impressora da expedição é a
 * `ZDesigner GC420t (EPL) (Copiar 1)` — driver em **EPL**, onde `~JSO`
 * simplesmente não existe e é ignorado. Em EPL o comando equivalente é `JB`
 * (*Disable Top Of Form Backup*). Supor a linguagem pelo fabricante foi o
 * erro; o nome do driver diz qual é, e agora ele decide.
 *
 * **2. Nada que faça a impressora andar.** Os comandos `~` (control) são
 * processados na hora e não produzem papel. Ficaram DE FORA, de propósito:
 *   - `~JC`/`~JG` (calibrar) — faz exatamente o que queremos evitar e gasta
 *     etiqueta a cada envio;
 *   - `^MN` (media tracking) — errado, a impressora cospe etiquetas em branco;
 *   - `^MD`/`~SD` (darkness) — borra ou apaga o código de barras, e código que
 *     não lê na transportadora é um problema muito pior que 1,5 s de pausa;
 *   - `^LL`/`^PW` (tamanho) — dependem da mídia instalada; errado, corta o
 *     conteúdo;
 *   - `^JUS` (gravar na memória não volátil) — desgasta a EEPROM se enviado a
 *     cada impressão, e `~JS` já persiste sozinho.
 *
 * **3. Uma vez por impressora, não a cada etiqueta.** O pedido foi "antes de
 * toda impressão"; o efeito é o mesmo e o custo é menor assim. `~JS` é
 * configuração PERSISTENTE (sobrevive a desligar a impressora), então
 * repetir a cada lote só enfileira trabalho a mais no spooler. O reenvio
 * periódico cobre o caso de alguém restaurar o padrão de fábrica.
 */

/** Quanto tempo até reenviar o preparo para a mesma impressora. */
const INTERVALO_MS = 60 * 60 * 1000;

/**
 * Impressoras que falam ZPL, pelo nome que o Windows expõe.
 *
 * ⚠️ Lista de ACEITE, nunca de recusa: nome desconhecido não recebe nada. O
 * erro de não preparar é uma pausa que já existe; o de preparar errado é uma
 * folha impressa com "~JSO" em cada impressão.
 */
const NOME_DE_ZEBRA = /zebra|zdesigner|\bzd[24]\d{2}\b|\bg[ckx]4\d{2}\b|\bzt[24]\d{2}\b|\bzp\s?5\d{2}\b|\bzq\d{3}\b/i;

/** O driver anuncia a linguagem no próprio nome: "ZDesigner GC420t (EPL)". */
const NOME_DE_EPL = /\bepl\b/i;

function ehZebra(nomeDaImpressora) {
  return NOME_DE_ZEBRA.test(String(nomeDaImpressora || ''));
}

/**
 * `'epl'` | `'zpl'` | `null` — a linguagem que esta impressora entende.
 *
 * ⚠️ O sufixo `(EPL)` no nome do driver é a única pista confiável que temos
 * sem conversar com o equipamento. Errar aqui é mandar um comando que a
 * impressora ignora (o caso da 1.0.5) — ou, pior, que ela imprime.
 */
function linguagemDaImpressora(nomeDaImpressora) {
  const nome = String(nomeDaImpressora || '');
  if (!ehZebra(nome)) return null;
  return NOME_DE_EPL.test(nome) ? 'epl' : 'zpl';
}

/**
 * Os comandos, na ordem.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 ERA `~JSO` E ISSO CUSTAVA UMA ETIQUETA EM BRANCO POR IMPRESSÃO
 *    (26/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Relato do dono, depois de testar na ZD220: *"a etiqueta do Meli na Zebra da
 * MALU ainda tá imprimindo duas páginas, e uma delas em branco"*.
 *
 * O ZPL não tinha culpa — o job que saiu foi medido no banco (job 186148,
 * 44.539 bytes): **um** `^XA`, `^LL1199` e `^PW799`, bitmap de 800 × 1199
 * pontos = 100,1 × 150,0 mm. Uma etiqueta só, do tamanho exato do papel.
 *
 * A folha extra vinha DESTE comando. O mecanismo está escrito no cabeçalho
 * deste arquivo desde o dia em que ele entrou: em Tear-Off a Zebra *"avança a
 * etiqueta até a barra de destaque quando termina e **recua** antes da
 * próxima"*. `~JSO` é **Backfeed Sequence: Off** — ele desliga justamente o
 * recuo. Sem ele, a impressão seguinte começa onde o papel parou, uma
 * etiqueta à frente, e a que estava sob a cabeça sai BRANCA.
 *
 * ⚠️ **`~JSA` resolve os dois lados.** O backfeed volta a existir (nenhuma
 * etiqueta é perdida), mas 100% dele passa a acontecer **depois** de
 * imprimir — no tempo morto em que o operador destaca o papel. A pausa que a
 * expedição reclamava em 09/10 era o recuo *antes* da próxima; com `~JSA`
 * ela sai do caminho crítico.
 *
 * ⚠️ **O EPL fica como está.** Lá o comando é `JB`, liga/desliga, sem o
 * "quando" — e quem reclamou da pausa original foi justamente a GC420t em
 * EPL. Trocar os dois de uma vez devolveria a pausa a quem o `JB` atende,
 * para corrigir um sintoma que não é dela. Se a folha em branco aparecer numa
 * EPL, o caminho é remover o `JB` daquela máquina pelo freio por impressora.
 *
 * **ZPL** — `~JSA` (*Backfeed Sequence: After*). Control command: a
 * impressora processa na hora, sem imprimir nem avançar.
 *
 * **EPL** — `JB` (*Disable Top Of Form Backup*). Mesmo efeito, outra
 * linguagem. É o que a impressora da expedição entende, e o que faltava na
 * 1.0.5.
 *
 * `^XA^MMT^PR{v}^XZ` — formato de configuração, OPCIONAL (ver `velocidade`):
 *   - `^MMT` garante o modo Tear-Off (se a impressora estiver em Peel ou
 *     Cutter, o backfeed volta por outro caminho);
 *   - `^PR` é a velocidade de impressão em polegadas/s. A GC420t da expedição
 *     vai até 4; valor acima do suportado é limitado pela própria impressora.
 *
 * ⚠️ O formato de configuração é separado e desligável porque um `^XA…^XZ`
 * sem campo imprimível **não deveria** produzir etiqueta — mas "não deveria"
 * depende do firmware, e uma etiqueta em branco por lote é desperdício
 * visível. O `~JSO`, que é o que importa, não tem essa dúvida.
 */
function comandosDePreparo({ velocidade = null, linguagem = 'zpl' } = {}) {
  if (linguagem === 'epl') {
    const partes = ['JB'];
    // `S<n>` é a velocidade em EPL. Desligada por padrão, pela mesma razão do
    // `^PR`: mexer em parâmetro de impressão sem ver o papel.
    if (velocidade) partes.push(`S${velocidade}`);
    return partes.join('\n') + '\n';
  }
  const partes = ['~JSA'];
  if (velocidade) partes.push(`^XA^MMT^PR${velocidade}^XZ`);
  return partes.join('\n') + '\n';
}

/**
 * Cria o preparador.
 *
 * @param {(nome: string, texto: string) => Promise<void>} enviarZpl
 * @param {(mensagem: string) => void} [registrar]
 * @param {() => number} [agora] injetável para o teste não depender do relógio
 */
function criarPreparoDeImpressora({
  enviarZpl,
  desligarBidi = null,
  registrar = () => {},
  agora = Date.now,
  intervaloMs = INTERVALO_MS,
}) {
  /** `nome\0linguagem` → instante do último preparo bem-sucedido */
  const ultimoPreparo = new Map();

  /**
   * Prepara a impressora se for Zebra e se já passou do intervalo.
   *
   * ⚠️ **Nunca lança.** Preparo é otimização: se falhar, a etiqueta tem de
   * sair assim mesmo. Um erro aqui derrubando a impressão trocaria uma pausa
   * de 1,5 s por uma etiqueta que não imprime.
   */
  async function preparar(nomeDaImpressora, opcoes = {}) {
    if (opcoes.ligado === false) return 'desligado';
    /*
     * ⚠️ **Quem manda é o JOB, não o nome do driver** (09/10/2026). Desde a
     * conversão PDF→ZPL no servidor, a etiqueta pode chegar como ZPL cru para
     * a MESMA impressora cujo driver é EPL — e a Zebra troca de linguagem
     * sozinha ao ver o `^XA` ("automatic printer language detection and
     * switching", manual da GC420t). Nesse caso ela está em ZPL e quem vale é
     * o `~JSA`; o nome do driver passa a ser só o palpite de quando o job vem
     * em PDF, que é o caminho que de fato passa pelo driver.
     */
    const linguagem = opcoes.linguagem || linguagemDaImpressora(nomeDaImpressora);
    if (!linguagem || !ehZebra(nomeDaImpressora)) return 'nao_e_zebra';

    /*
     * ⚠️ A memória é por (impressora, LINGUAGEM). A mesma máquina recebendo um
     * lote em ZPL e outro em PDF precisa dos dois comandos: em modo ZPL o `JB`
     * é ignorado, e em modo EPL o `~JSA` também. Com a chave só no nome, o
     * segundo modo ficaria uma hora sem preparo nenhum.
     */
    const chave = `${nomeDaImpressora}\u0000${linguagem}`;
    const ultimo = ultimoPreparo.get(chave);
    if (ultimo && agora() - ultimo < intervaloMs) return 'recente';

    try {
      /*
       * ⚠️ O DESTINO VAI JUNTO (30/10/2026). O preparo chamava o envio sem
       * dizer para ONDE — e o envio, sem destino, cai no spooler do Windows.
       * Numa Zebra configurada por IP (`zpl_host`) isso tem duas
       * consequências, as duas observadas na VM de teste:
       *
       *  1. a impressora NUNCA recebe o `~JSA`/`JB`, que é o comando que tira
       *     a pausa entre etiquetas — exatamente a queixa de lentidão que
       *     originou esta investigação;
       *  2. o comando vai para a fila do Windows de MESMO NOME, que pode nem
       *     ser o mesmo equipamento. Configurar a impressora errada é pior do
       *     que não configurar nenhuma.
       *
       * Quem manda o preparo tem de mandá-lo pelo mesmo caminho do job.
       */
      /*
       * ⚠️ CRONOMETRADO (31/10/2026). Medido no Hub: na RDF
       * (LAPTOP-KO8NI12G, 16 filas instaladas) a PRIMEIRA etiqueta de um
       * lote levou 58 s até o ACK e as 8 seguintes saíram em 9 s. Nas
       * outras máquinas (7 filas) a primeira leva 0,6 a 1,3 s.
       *
       * Havia duas etapas em sequência aqui e NENHUMA registrava tempo —
       * então não havia como dizer se o minuto era o comando ZPL, a
       * consulta WMI do bidirecional, ou a impressora acordando. Sem o
       * número, a correção seria palpite; e palpite já custou duas
       * releases neste repositório.
       */
      const tEnvio = agora();
      await enviarZpl(nomeDaImpressora, comandosDePreparo({ ...opcoes, linguagem }), {
        zplHost: opcoes.zplHost || null,
        zplPort: opcoes.zplPort || null,
      });
      const msEnvio = agora() - tEnvio;
      ultimoPreparo.set(chave, agora());
      registrar(
        `impressora ${nomeDaImpressora} preparada em ${linguagem.toUpperCase()} ` +
          `(backfeed desligado) — comando levou ${msEnvio} ms`,
      );
      /*
       * ⚠️ DEPOIS do comando, e com erro isolado: desligar o bidirecional é a
       * segunda causa (ver o cabeçalho), mas mexe na fila do Windows e pode
       * exigir elevação. Falhar aqui não pode apagar o preparo que deu certo.
       */
      if (desligarBidi && opcoes.bidi !== false) {
        const tBidi = agora();
        try {
          const r = await desligarBidi(nomeDaImpressora);
          registrar(`${nomeDaImpressora}: ${r} — bidirecional levou ${agora() - tBidi} ms`);
        } catch (erro) {
          // ⚠️ O tempo entra no log do ERRO também: timeout de 15 s é o
          // sintoma que distingue "WMI travado" de "WMI que respondeu não".
          registrar(
            `${nomeDaImpressora}: nao foi possivel desligar o bidirecional ` +
              `em ${agora() - tBidi} ms (${erro && erro.message ? erro.message : erro})`,
          );
        }
      }
      return 'preparada';
    } catch (erro) {
      // Não marca como preparada: a próxima impressão tenta de novo.
      registrar(
        `preparo de ${nomeDaImpressora} falhou (${erro && erro.message ? erro.message : erro}) — imprimindo assim mesmo`,
      );
      return 'falhou';
    }
  }

  /** Só para teste/diagnóstico. */
  function esquecer() {
    ultimoPreparo.clear();
  }

  /**
   * O comando de preparo PARA IR COLADO na frente da etiqueta — ou `null`.
   *
   * ══════════════════════════════════════════════════════════════════════════
   * 🚨 MANDAR 5 BYTES CUSTOU 16 SEGUNDOS (31/10/2026)
   * ══════════════════════════════════════════════════════════════════════════
   * Medido no `print.log` da RDF (LAPTOP-KO8NI12G, 16 filas instaladas), com
   * a 1.0.24 cronometrando cada etapa:
   *
   *   [zpl]     1 etiqueta(s),   0 KB aceitos pelo winspool em 16182 ms  ← preparo
   *   [preparo] bidi_ja_estava_desligado — bidirecional levou 11610 ms
   *   [zpl]     1 etiqueta(s),  41 KB aceitos pelo winspool em  2425 ms  ← etiqueta
   *   [zpl]     9 etiqueta(s), 335 KB aceitos pelo winspool em  2687 ms
   *
   * 27,8 s de preparação para 5,1 s de impressão. E o número que decide:
   * **5 bytes levaram 16 s e 335 KB levaram 2,7 s** — o custo não é o volume,
   * é ABRIR a impressora no spooler. Hoje abrimos duas vezes (o comando e a
   * etiqueta); colado, abre uma.
   *
   * ⚠️ Só serve quando a linguagem do PREPARO é a mesma do JOB. Numa Zebra em
   * modo EPL o `~JSA` é ignorado e o `JB` é o que vale — mandar o comando de
   * uma linguagem colado no formato de outra é pior que não preparar.
   *
   * ⚠️ **Não marca nada.** Quem envia é que sabe se chegou, e chama
   * `confirmarPreparo` depois. Marcar aqui faria o preparo ser "feito" mesmo
   * quando a etiqueta falhou, e a impressora ficaria uma hora sem o comando.
   */
  function comandoColado(nomeDaImpressora, opcoes = {}) {
    if (opcoes.ligado === false) return null;
    const doDriver = linguagemDaImpressora(nomeDaImpressora);
    if (!doDriver || !ehZebra(nomeDaImpressora)) return null;

    /*
     * ⚠️ A linguagem do JOB tem de ser explícita E igual à do DRIVER.
     *
     * Aqui a regra é MAIS ESTRITA que no `preparar()`, de propósito. Lá o job
     * manda, porque a Zebra troca de linguagem sozinha ao ver o `^XA`. Mas o
     * comando colado vai ANTES do `^XA`: naquele instante a impressora ainda
     * está no modo do driver, e um `~JSA` lido em modo EPL não é comando — é
     * lixo. Quando as duas divergem, o caminho antigo (envio separado)
     * continua valendo, com o comportamento idêntico ao de hoje.
     *
     * ⚠️ Defeito meu que o teste pegou em 31/10/2026: a comparação era contra
     * `opcoes.linguagem || doDriver`, que é a própria `opcoes.linguagem`
     * quando ela existe — a guarda nunca podia falhar, e um job ZPL colava o
     * `~JSA` numa impressora em modo EPL.
     */
    if (!opcoes.linguagem || opcoes.linguagem !== doDriver) return null;
    const linguagem = doDriver;

    const chave = `${nomeDaImpressora}\u0000${linguagem}`;
    const ultimo = ultimoPreparo.get(chave);
    if (ultimo && agora() - ultimo < intervaloMs) return null;

    return { chave, texto: comandosDePreparo({ ...opcoes, linguagem }), linguagem };
  }

  /** O envio que levava o comando colado deu certo: conta o preparo. */
  function confirmarPreparo(chave) {
    if (chave) ultimoPreparo.set(chave, agora());
  }

  /**
   * Desliga o bidirecional DEPOIS da etiqueta — fora do caminho crítico.
   *
   * ⚠️ Medido na RDF em 31/10/2026: **11.610 ms** de consulta WMI, e ela
   * rodava ANTES da primeira etiqueta. O bidirecional é otimização para as
   * etiquetas SEGUINTES (é ele que tira a pausa entre elas), então esperar
   * por ele antes de o papel começar a sair é pagar o custo na hora errada.
   *
   * ⚠️ **Nunca lança e nunca é esperado.** Quem chama usa `void`. Falha aqui
   * não pode derrubar impressão que já deu certo — era assim no `preparar()`
   * e continua sendo.
   *
   * ⚠️ Memória PRÓPRIA, separada da do preparo: o comando ZPL e a
   * configuração do spooler são coisas diferentes, e misturá-las faria o
   * bidi deixar de rodar sempre que o preparo tivesse ido colado.
   */
  const ultimoBidi = new Map();

  async function desligarBidiDepois(nomeDaImpressora, opcoes = {}) {
    if (!desligarBidi || opcoes.bidi === false) return 'desligado';
    if (!ehZebra(nomeDaImpressora)) return 'nao_e_zebra';
    const ultimo = ultimoBidi.get(nomeDaImpressora);
    if (ultimo && agora() - ultimo < intervaloMs) return 'recente';

    const t = agora();
    try {
      const r = await desligarBidi(nomeDaImpressora);
      ultimoBidi.set(nomeDaImpressora, agora());
      registrar(`${nomeDaImpressora}: ${r} — bidirecional levou ${agora() - t} ms (fora do caminho)`);
      return 'ok';
    } catch (erro) {
      // Não marca: a próxima impressão tenta de novo.
      registrar(
        `${nomeDaImpressora}: nao foi possivel desligar o bidirecional em ${agora() - t} ms ` +
          `(${erro && erro.message ? erro.message : erro})`,
      );
      return 'falhou';
    }
  }

  return { preparar, esquecer, comandoColado, confirmarPreparo, desligarBidiDepois };
}

/**
 * O comando WMI que desliga o bidirecional de UMA fila de impressão.
 *
 * ⚠️ `Put()` grava na configuração do spooler — pode exigir elevação. Quando
 * não houver, o erro vai para o log e a impressão segue: é otimização, não
 * requisito.
 *
 * ⚠️ O nome da impressora entra com aspas simples DOBRADAS, não escapadas com
 * barra: é WQL dentro de PowerShell, e `Zebra's` quebraria a consulta.
 */
function comandoDesligarBidi(nomeDaImpressora) {
  const nome = String(nomeDaImpressora).replace(/'/g, "''");
  return (
    `$p = Get-WmiObject Win32_Printer -Filter "Name='${nome}'"; ` +
    'if ($p -and $p.EnableBIDI) { $p.EnableBIDI = $false; $r = $p.Put(); ' +
    "Write-Output 'bidi_desligado' } " +
    "elseif ($p) { Write-Output 'bidi_ja_estava_desligado' } " +
    "else { Write-Output 'impressora_nao_encontrada' }"
  );
}

/**
 * Cola o comando de preparo na frente do corpo da etiqueta.
 *
 * ⚠️ Existe como função SEPARADA porque a montagem ficava dentro do
 * `main.js` e, ao verificar desfazendo em 31/10/2026, removê-la passou pelos
 * 29 casos estruturais sem nenhum vermelho — eles conferem presença de
 * código, não bytes. Aqui a asserção é sobre o RESULTADO: o corpo da
 * etiqueta sai intacto e o comando vem antes dele.
 *
 * ⚠️ `ascii` e não `utf8`: o preparo é `~JSA`/`JB`, sempre ASCII puro, e a
 * impressora lê byte a byte. Um BOM ou um acento aqui vira caractere de
 * controle no meio do fluxo ZPL.
 */
function colarNaEtiqueta(textoDoPreparo, corpo) {
  if (!textoDoPreparo) return corpo;
  return Buffer.concat([Buffer.from(textoDoPreparo, 'ascii'), corpo]);
}

module.exports = {
  criarPreparoDeImpressora,
  colarNaEtiqueta,
  comandoDesligarBidi,
  comandosDePreparo,
  ehZebra,
  linguagemDaImpressora,
  NOME_DE_ZEBRA,
  INTERVALO_MS,
};
