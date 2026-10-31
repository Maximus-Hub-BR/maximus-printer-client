/**
 * Teste do preparo da impressora — `node src/preparo-impressora.test.js`.
 *
 * O que se prova aqui é quase todo sobre o que NÃO fazer. Preparo é a única
 * coisa que este programa escreve na configuração de um equipamento alheio:
 * mandar para a impressora errada imprime lixo numa folha, e mandar comando
 * errado estraga a impressão de quem está trabalhando.
 */
const assert = require('assert');
const {
  criarPreparoDeImpressora,
  comandoDesligarBidi,
  comandosDePreparo,
  ehZebra,
  linguagemDaImpressora,
  INTERVALO_MS,
  colarNaEtiqueta,
} = require('./preparo-impressora');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

function montar({ falhar = false, bidiFalha = false, semBidi = false, agora = () => 1000, intervaloMs } = {}) {
  const enviados = [];
  const bidis = [];
  const logs = [];
  const preparo = criarPreparoDeImpressora({
    agora,
    intervaloMs,
    enviarZpl: async (nome, texto) => {
      if (falhar) throw new Error('impressora offline');
      enviados.push({ nome, texto });
    },
    desligarBidi: semBidi ? null : async (nome) => {
      if (bidiFalha) throw new Error('acesso negado');
      bidis.push(nome);
      return 'bidi_desligado';
    },
    registrar: (m) => logs.push(m),
  });
  return { preparo, enviados, bidis, logs };
}

// ── quem recebe ────────────────────────────────────────────────────────────
describe_bloco('a detecção é lista de ACEITE', () => {
  teste('reconhece as Zebras da expedição', () => {
    assert.ok(ehZebra('ZDesigner GC420t (Copiar 1)'));
    assert.ok(ehZebra('ZDesigner GC420t (EPL) (Copiar 1)'));
    assert.ok(ehZebra('Zebra ZD220'));
    assert.ok(ehZebra('ZDesigner ZT411'));
  });

  /**
   * ⚠️ O caso que justifica a lista ser de aceite: `~JSO` numa laser comum
   * sai IMPRESSO numa folha, a cada lote.
   */
  teste('NÃO reconhece impressora que não fala ZPL', () => {
    for (const nome of [
      'Microsoft Print to PDF',
      'OneNote (Desktop)',
      'Microsoft XPS Document Writer',
      'Fax',
      'HP LaserJet 1020',
      'EPSON L3150',
      '',
      null,
    ]) {
      assert.strictEqual(ehZebra(nome), false, `casou indevidamente: ${nome}`);
    }
  });

  teste('impressora desconhecida não recebe nada', async () => {
    const { preparo, enviados } = montar();
    assert.strictEqual(await preparo.preparar('HP LaserJet 1020'), 'nao_e_zebra');
    assert.deepStrictEqual(enviados, []);
  });
});

// ── a linguagem ────────────────────────────────────────────────────────────
describe_bloco('ZPL ou EPL — o driver diz qual', () => {
  /**
   * ⚠️ O caso que a 1.0.5 errou. A impressora da expedição é a
   * `ZDesigner GC420t (EPL) (Copiar 1)`: o `~JSO` (ZPL) foi enviado, a
   * impressora ignorou, e a pausa continuou. Supor a linguagem pelo
   * fabricante não funciona — o sufixo do driver é quem sabe.
   */
  teste('o sufixo (EPL) no nome decide a linguagem', () => {
    assert.strictEqual(linguagemDaImpressora('ZDesigner GC420t (EPL) (Copiar 1)'), 'epl');
    assert.strictEqual(linguagemDaImpressora('ZDesigner GC420t (Copiar 1)'), 'zpl');
    assert.strictEqual(linguagemDaImpressora('Zebra ZD220'), 'zpl');
    assert.strictEqual(linguagemDaImpressora('Microsoft Print to PDF'), null);
  });

  teste('em EPL o comando é `JB`, não `~JSA`', () => {
    assert.strictEqual(comandosDePreparo({ linguagem: 'epl' }), 'JB\n');
    assert.ok(!comandosDePreparo({ linguagem: 'epl' }).includes('~JSA'));
  });

  teste('a impressora recebe o comando da SUA linguagem', async () => {
    const { preparo, enviados } = montar();
    await preparo.preparar('ZDesigner GC420t (EPL) (Copiar 1)');
    await preparo.preparar('ZDesigner GC420t (Copiar 1)');
    assert.deepStrictEqual(enviados.map((e) => e.texto), ['JB\n', '~JSA\n']);
  });

  /**
   * ⚠️ Desde a conversão PDF→ZPL no servidor (09/10/2026), a MESMA impressora
   * recebe ZPL cru mesmo com o driver EPL instalado: a Zebra troca de modo ao
   * ver o `^XA`. Nesse caso quem vale é o `~JSO`, e o nome do driver passa a
   * ser só o palpite do caminho em PDF.
   */
  teste('a linguagem do JOB vence o nome do driver', async () => {
    const { preparo, enviados } = montar();
    await preparo.preparar('ZDesigner GC420t (EPL) (Copiar 1)', { linguagem: 'zpl' });
    assert.deepStrictEqual(enviados.map((e) => e.texto), ['~JSA\n']);
  });

  /**
   * ⚠️ Em modo ZPL o `JB` é ignorado, e em modo EPL o `~JSO` também. Com a
   * memória guardada só pelo nome, o segundo modo ficaria uma hora inteira
   * sem preparo nenhum — e a pausa voltaria só nele.
   */
  teste('a mesma impressora é preparada nas DUAS linguagens', async () => {
    const { preparo, enviados } = montar();
    assert.strictEqual(await preparo.preparar('Zebra ZD220', { linguagem: 'zpl' }), 'preparada');
    assert.strictEqual(await preparo.preparar('Zebra ZD220', { linguagem: 'epl' }), 'preparada');
    assert.deepStrictEqual(enviados.map((e) => e.texto), ['~JSA\n', 'JB\n']);
    // mas não repete a mesma linguagem dentro do intervalo
    assert.strictEqual(await preparo.preparar('Zebra ZD220', { linguagem: 'zpl' }), 'recente');
  });

  /** A linguagem do job não pode fazer uma laser comum receber `~JSO`. */
  teste('`linguagem` do job NÃO contorna a lista de aceite', async () => {
    const { preparo, enviados } = montar();
    assert.strictEqual(
      await preparo.preparar('HP LaserJet 1020', { linguagem: 'zpl' }),
      'nao_e_zebra',
    );
    assert.deepStrictEqual(enviados, []);
  });

  teste('a velocidade em EPL é `S<n>`', () => {
    assert.strictEqual(comandosDePreparo({ linguagem: 'epl', velocidade: 4 }), 'JB\nS4\n');
  });
});

// ── o que é enviado ────────────────────────────────────────────────────────
describe_bloco('os comandos', () => {
  /*
   * 🚨 **INVERTIDO em 26/10/2026, e o motivo é uma etiqueta por impressão.**
   *
   * Era `~JSO` (*Backfeed Sequence: Off*), que desliga o recuo que a Zebra faz
   * em Tear-Off antes de imprimir. Sem o recuo, a impressão seguinte começa
   * uma etiqueta à frente e a que estava sob a cabeça sai BRANCA — foi o que
   * o dono viu na ZD220: *"tá imprimindo duas páginas, e uma delas em
   * branco"*. O job foi medido e estava correto (um ^XA, 100,1 × 150,0 mm):
   * a folha extra era deste comando.
   *
   * `~JSA` mantém o backfeed (nenhuma etiqueta perdida) e o joga 100% para
   * DEPOIS da impressão, no tempo morto em que o operador destaca o papel.
   */
  teste('o preparo mínimo é só `~JSA` — backfeed DEPOIS, nunca desligado', () => {
    assert.strictEqual(comandosDePreparo(), '~JSA\n');
  });

  /**
   * ⚠️ A lista negra. Cada um destes já tem motivo escrito no módulo: calibrar
   * gasta etiqueta, tracking errado cospe papel, darkness apaga o código de
   * barras, tamanho errado corta o conteúdo, e `^JUS` desgasta a EEPROM.
   */
  teste('NUNCA envia comando que mexe em mídia, calibra ou grava memória', () => {
    const tudo = comandosDePreparo({ velocidade: 4 });
    for (const proibido of ['~JC', '~JG', '^MN', '^MD', '~SD', '^LL', '^PW', '^JUS']) {
      assert.ok(!tudo.includes(proibido), `enviou ${proibido}`);
    }
  });

  teste('a velocidade só entra quando pedida, e dentro de um formato', () => {
    assert.ok(!comandosDePreparo().includes('^PR'));
    assert.strictEqual(comandosDePreparo({ velocidade: 4 }), '~JSA\n^XA^MMT^PR4^XZ\n');
  });
});

// ── quando é enviado ───────────────────────────────────────────────────────
describe_bloco('a frequência', () => {
  teste('prepara na primeira impressão', async () => {
    const { preparo, enviados } = montar();
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'preparada');
    assert.strictEqual(enviados.length, 1);
    assert.strictEqual(enviados[0].texto, '~JSA\n');
  });

  /** `~JS` é configuração persistente: repetir a cada lote só enche o spooler. */
  teste('não repete dentro do intervalo', async () => {
    const { preparo, enviados } = montar();
    await preparo.preparar('Zebra ZD220');
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'recente');
    assert.strictEqual(enviados.length, 1);
  });

  teste('reenvia depois do intervalo (cobre reset de fábrica)', async () => {
    let t = 1000;
    const { preparo, enviados } = montar({ agora: () => t, intervaloMs: 5000 });
    await preparo.preparar('Zebra ZD220');
    t += 6000;
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'preparada');
    assert.strictEqual(enviados.length, 2);
  });

  teste('cada impressora tem o seu próprio controle', async () => {
    const { preparo, enviados } = montar();
    await preparo.preparar('Zebra ZD220');
    await preparo.preparar('ZDesigner GC420t');
    assert.deepStrictEqual(enviados.map((e) => e.nome), ['Zebra ZD220', 'ZDesigner GC420t']);
  });
});

// ── quando dá errado ───────────────────────────────────────────────────────
describe_bloco('falha', () => {
  /**
   * ⚠️ Trocar uma pausa de 1,5 s por uma etiqueta que não sai seria um
   * péssimo negócio. Preparo é otimização: falhou, segue.
   */
  teste('falha no envio NÃO lança — a etiqueta sai assim mesmo', async () => {
    const { preparo, logs } = montar({ falhar: true });
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'falhou');
    assert.ok(logs.join(' ').includes('imprimindo assim mesmo'));
  });

  teste('falha não marca como preparada — a próxima tenta de novo', async () => {
    const enviados = [];
    let deveFalhar = true;
    const preparo = criarPreparoDeImpressora({
      enviarZpl: async (nome, texto) => {
        if (deveFalhar) throw new Error('offline');
        enviados.push({ nome, texto });
      },
    });
    await preparo.preparar('Zebra ZD220');
    deveFalhar = false;
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'preparada');
    assert.strictEqual(enviados.length, 1);
  });

  /** O freio de mão: desligar sem precisar de release. */
  teste('`ligado: false` não envia nada', async () => {
    const { preparo, enviados } = montar();
    assert.strictEqual(await preparo.preparar('Zebra ZD220', { ligado: false }), 'desligado');
    assert.deepStrictEqual(enviados, []);
  });
});

// ── o bidirecional ─────────────────────────────────────────────────────────
describe_bloco('desligar o bidirecional da fila do Windows', () => {
  /**
   * ⚠️ A segunda causa, e a documentada pela Zebra: "long delay before jobs
   * print or between print jobs" em USB, por temporização entre o Windows e
   * o Language Monitor do driver. A correção é da FILA, não da impressora —
   * e por isso cabe a um SaaS aplicá-la sozinho.
   */
  teste('o preparo também desliga o bidirecional', async () => {
    const { preparo, bidis } = montar();
    await preparo.preparar('Zebra ZD220');
    assert.deepStrictEqual(bidis, ['Zebra ZD220']);
  });

  teste('a consulta WQL dobra a aspa simples do nome', () => {
    const cmd = comandoDesligarBidi("Zebra's ZD220");
    assert.ok(cmd.includes("Name='Zebra''s ZD220'"));
  });

  teste('não mexe em quem já está desligado', () => {
    assert.ok(comandoDesligarBidi('X').includes('bidi_ja_estava_desligado'));
  });

  /** Mexer na fila pode exigir elevação — e falhar nisso não pode apagar o
   * preparo que deu certo nem impedir a impressão. */
  teste('falha ao desligar o bidi NÃO derruba o preparo', async () => {
    const { preparo, enviados, logs } = montar({ bidiFalha: true });
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'preparada');
    assert.strictEqual(enviados.length, 1);
    assert.ok(logs.join(' ').includes('nao foi possivel desligar o bidirecional'));
  });

  teste('`bidi: false` pula só essa parte', async () => {
    const { preparo, enviados, bidis } = montar();
    await preparo.preparar('Zebra ZD220', { bidi: false });
    assert.strictEqual(enviados.length, 1);
    assert.deepStrictEqual(bidis, []);
  });

  teste('sem a porta `desligarBidi`, o preparo funciona igual', async () => {
    const { preparo, enviados } = montar({ semBidi: true });
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'preparada');
    assert.strictEqual(enviados.length, 1);
  });
});

function describe_bloco(nome, fn) {
  casos.push([`── ${nome}`, null]);
  fn();
}

(async () => {
  /*
 * ══════════════════════════════════════════════════════════════════════════
 * O COMANDO COLADO NA ETIQUETA — o que economiza 16 s na RDF
 * ══════════════════════════════════════════════════════════════════════════
 * Medido em 31/10/2026: mandar os 5 bytes do preparo sozinho custou 16.182 ms
 * naquela máquina, e 335 KB custaram 2.687 ms. O custo é ABRIR a impressora
 * no spooler, não o volume — então o comando vai colado e abre uma vez só.
 *
 * ⚠️ Estes casos não substituem os do `preparar()`: o caminho antigo continua
 * existindo e testado, para PDF e para quando a linguagem não casa.
 */

teste('🚨 comandoColado devolve o ~JSA quando o job é ZPL numa Zebra', () => {
  const { preparo } = montar();
  const c = preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl' });
  assert.ok(c, 'devia ter comando a colar');
  assert.ok(c.texto.includes('~JSA'), `texto inesperado: ${JSON.stringify(c.texto)}`);
  assert.ok(c.chave, 'a chave é o que permite confirmar depois');
});

teste('🚨 NÃO cola quando a linguagem do job difere da da impressora', () => {
  // Zebra cujo driver anuncia EPL, recebendo job ZPL: o `JB` não vale em modo
  // ZPL e o `~JSA` não vale em EPL. Colar o comando errado é pior que nada.
  const { preparo } = montar();
  assert.strictEqual(preparo.comandoColado('ZDesigner GC420t (EPL)', { linguagem: 'zpl' }), null);
});

teste('⚠️ NÃO cola sem a linguagem do JOB declarada', () => {
  // Sem ela não se sabe em que modo a impressora vai LER os bytes colados.
  const { preparo } = montar();
  assert.strictEqual(preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', {}), null);
});

teste('comandoColado respeita a lista de ACEITE (não é Zebra, não cola)', () => {
  const { preparo } = montar();
  assert.strictEqual(preparo.comandoColado('TOMATE_MDK_008', { linguagem: 'zpl' }), null);
  assert.strictEqual(preparo.comandoColado('Microsoft Print to PDF', { linguagem: 'zpl' }), null);
});

teste('comandoColado respeita `ligado: false`', () => {
  const { preparo } = montar();
  assert.strictEqual(
    preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl', ligado: false }),
    null,
  );
});

teste('🚨 comandoColado NÃO marca por si: sem confirmar, ele insiste', () => {
  /*
   * Se marcasse na hora, um envio que FALHOU contaria como preparo feito e a
   * impressora ficaria uma hora sem o comando — trocando 16 s de economia
   * pela pausa entre etiquetas, que é a queixa de origem.
   */
  const { preparo } = montar();
  const a = preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl' });
  const b = preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl' });
  assert.ok(a && b, 'enquanto ninguém confirma, ele continua pedindo');
});

teste('🚨 depois de confirmar, não cola de novo dentro do intervalo', () => {
  const { preparo } = montar();
  const c = preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl' });
  preparo.confirmarPreparo(c.chave);
  assert.strictEqual(preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl' }), null);
});

teste('⚠️ passado o intervalo, volta a colar (cobre reset de fábrica)', () => {
  let t = 0;
  const { preparo } = montar({ agora: () => t });
  const c = preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl' });
  preparo.confirmarPreparo(c.chave);
  t += INTERVALO_MS + 1;
  assert.ok(preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl' }));
});

teste('⚠️ o preparo COLADO e o preparo por envio compartilham a memória', () => {
  // Senão a impressora receberia o comando duas vezes, por dois caminhos.
  const { preparo } = montar();
  const c = preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl' });
  preparo.confirmarPreparo(c.chave);
  return preparo
    .preparar('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl' })
    .then((r) => assert.strictEqual(r, 'recente', `esperava 'recente', veio '${r}'`));
});

teste('🚨 o texto colado é EXATAMENTE o mesmo do caminho antigo', () => {
  // A economia é no número de aberturas do spooler, não no comando: se o
  // conteúdo divergir, a impressora passa a ser configurada de outra forma.
  const { preparo, enviados } = montar();
  const c = preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl' });
  return preparo
    .preparar('ZDesigner 105SL 203DPI', { linguagem: 'zpl' })
    .then(() => {
      assert.ok(enviados.length, 'o caminho antigo não enviou nada');
      assert.strictEqual(c.texto, enviados[enviados.length - 1].texto);
    });
});

/*
 * O BIDIRECIONAL FORA DO CAMINHO CRÍTICO — 11,6 s que a etiqueta pagava
 */

teste('🚨 desligarBidiDepois roda o WMI e NÃO lança', async () => {
  const { preparo, bidis } = montar();
  const r = await preparo.desligarBidiDepois('ZDesigner ZD220-203dpi ZPL', {});
  assert.strictEqual(r, 'ok');
  assert.deepStrictEqual(bidis, ['ZDesigner ZD220-203dpi ZPL'], 'o bidi TEM de rodar — só não antes');
});

teste('🚨 falha no bidi NÃO derruba nada (impressão já deu certo)', async () => {
  const { preparo } = montar({ bidiFalha: true });
  const r = await preparo.desligarBidiDepois('ZDesigner ZD220-203dpi ZPL', {});
  assert.strictEqual(r, 'falhou', 'devolve o estado, nunca lança');
});

teste('⚠️ falha NÃO marca: a próxima impressão tenta de novo', async () => {
  const { preparo, bidis } = montar({ bidiFalha: true });
  await preparo.desligarBidiDepois('ZDesigner ZD220-203dpi ZPL', {});
  await preparo.desligarBidiDepois('ZDesigner ZD220-203dpi ZPL', {});
  assert.strictEqual(bidis.length, 0, 'as duas falharam, e as duas tentaram');
});

teste('não repete dentro do intervalo (WMI é caro: 11,6 s na RDF)', async () => {
  const { preparo, bidis } = montar();
  await preparo.desligarBidiDepois('ZDesigner ZD220-203dpi ZPL', {});
  const r = await preparo.desligarBidiDepois('ZDesigner ZD220-203dpi ZPL', {});
  assert.strictEqual(r, 'recente');
  assert.strictEqual(bidis.length, 1);
});

teste('🚨 a memória do bidi é SEPARADA da do preparo', async () => {
  /*
   * Se compartilhassem, o comando indo COLADO marcaria a chave e o bidi
   * nunca mais rodaria — e a pausa entre etiquetas (a queixa de origem da
   * RDF) voltaria em silêncio.
   */
  const { preparo, bidis } = montar();
  const c = preparo.comandoColado('ZDesigner ZD220-203dpi ZPL', { linguagem: 'zpl' });
  preparo.confirmarPreparo(c.chave);
  const r = await preparo.desligarBidiDepois('ZDesigner ZD220-203dpi ZPL', {});
  assert.strictEqual(r, 'ok', 'o preparo colado não pode cancelar o bidi');
  assert.strictEqual(bidis.length, 1);
});

teste('respeita `bidi: false` e a lista de aceite', async () => {
  const { preparo, bidis } = montar();
  assert.strictEqual(await preparo.desligarBidiDepois('ZDesigner ZD220-203dpi ZPL', { bidi: false }), 'desligado');
  assert.strictEqual(await preparo.desligarBidiDepois('TOMATE_MDK_008', {}), 'nao_e_zebra');
  assert.strictEqual(bidis.length, 0);
});

teste('sem a porta desligarBidi, não quebra', async () => {
  const { preparo } = montar({ semBidi: true });
  assert.strictEqual(await preparo.desligarBidiDepois('ZDesigner ZD220-203dpi ZPL', {}), 'desligado');
});

/*
 * A COLAGEM, medida por BYTES — o caso que faltava
 * ⚠️ Removê-la do main.js passou pelos 29 casos estruturais sem um vermelho.
 */

teste('🚨 sem preparo, o corpo da etiqueta sai INTACTO (byte a byte)', () => {
  const corpo = Buffer.from('^XA^FO50,50^FDTESTE^FS^XZ\n', 'ascii');
  const r = colarNaEtiqueta(null, corpo);
  assert.strictEqual(r.equals(corpo), true, 'sem preparo nada pode mudar na etiqueta');
  assert.strictEqual(colarNaEtiqueta(undefined, corpo).equals(corpo), true);
  assert.strictEqual(colarNaEtiqueta('', corpo).equals(corpo), true);
});

teste('🚨 com preparo, o comando vem ANTES e o corpo continua intacto', () => {
  const corpo = Buffer.from('^XA^FO50,50^FDTESTE^FS^XZ\n', 'ascii');
  const r = colarNaEtiqueta('~JSA\n', corpo);
  const texto = r.toString('ascii');
  assert.ok(texto.startsWith('~JSA\n'), `não começa com o preparo: ${JSON.stringify(texto.slice(0, 12))}`);
  // O corpo tem de sobreviver byte a byte depois do prefixo.
  assert.strictEqual(r.subarray(Buffer.byteLength('~JSA\n')).equals(corpo), true);
  // E o ^XA original não pode ter sido tocado.
  assert.strictEqual((texto.match(/\^XA/g) || []).length, 1);
});

teste('⚠️ o preparo vem antes do PRIMEIRO ^XA, nunca no meio do lote', () => {
  // Comando de configuração depois de um formato aberto é lido como dado.
  const lote = Buffer.concat([
    Buffer.from('^XA^FDA^FS^XZ\n', 'ascii'),
    Buffer.from('^XA^FDB^FS^XZ\n', 'ascii'),
  ]);
  const texto = colarNaEtiqueta('~JSA\n', lote).toString('ascii');
  assert.ok(texto.indexOf('~JSA') < texto.indexOf('^XA'), 'o preparo tem de preceder o primeiro formato');
  assert.strictEqual((texto.match(/~JSA/g) || []).length, 1, 'uma vez só, não por etiqueta');
});

teste('⚠️ a colagem é ASCII puro (byte estranho vira caractere de controle)', () => {
  const r = colarNaEtiqueta('~JSA\n', Buffer.from('^XA^XZ', 'ascii'));
  for (const b of r) assert.ok(b >= 0x09 && b <= 0x7e, `byte fora do ASCII imprimível: ${b}`);
});

for (const [nome, fn] of casos) {
    if (!fn) { console.log(`  ${nome}`); continue; }
    try {
      await fn();
      passaram++;
      console.log(`  ✓ ${nome}`);
    } catch (erro) {
      console.error(`  ✗ ${nome}\n    ${erro.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passaram}/${casos.filter(([, f]) => f).length} casos`);
})();

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * 🚨 A TRAVA: o backfeed nunca mais pode ser DESLIGADO (26/10/2026)
 * ═══════════════════════════════════════════════════════════════════════════
 * `~JSO` é a saída óbvia para "tirar a pausa entre etiquetas" — foi o que
 * fizemos em 09/10 e custou uma etiqueta em branco por impressão na ZD220. O
 * próximo que for atrás da mesma pausa vai encontrar o mesmo comando na
 * documentação da Zebra; este caso é o que o para.
 */
describe_bloco('o backfeed não volta a ser desligado', () => {
  teste('🚨 `~JSO` nunca é enviado, em nenhuma combinação', () => {
    for (const opcoes of [
      {},
      { velocidade: 4 },
      { linguagem: 'zpl' },
      { linguagem: 'zpl', velocidade: 2 },
      { linguagem: 'epl' },
      { linguagem: 'epl', velocidade: 4 },
    ]) {
      assert.ok(
        !comandosDePreparo(opcoes).includes('~JSO'),
        `~JSO voltou em ${JSON.stringify(opcoes)} — isso custa uma etiqueta por impressão`,
      );
    }
  });

  /*
   * ⚠️ E o comando continua existindo: tirar o `~JS` inteiro devolveria a
   * pausa de 0,5–1,5 s por etiqueta que a expedição reclamou em 09/10.
   */
  teste('mas o backfeed continua sendo configurado — só que para DEPOIS', () => {
    assert.ok(comandosDePreparo().startsWith('~JSA'));
  });
});
