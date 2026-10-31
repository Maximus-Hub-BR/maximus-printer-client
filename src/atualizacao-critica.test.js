/**
 * Quando o Print Client pode se reiniciar sozinho — ver o cabeçalho de
 * `atualizacao-critica.js` para a medição que motivou (5 dias numa versão
 * com defeito conhecido, porque a instalação esperava alguém fechar o app).
 */
const assert = require('assert');
const {
  decidirReinicio,
  explicarReinicio,
  INTERVALO_DE_TENTATIVA_MS,
} = require('./atualizacao-critica');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

const base = { baixado: true, obrigatoria: true, imprimindo: false, acksPendentes: 0 };

teste('🚨 ocioso + crítica + sem pendência ⇒ REINICIA', () => {
  assert.deepStrictEqual(decidirReinicio(base), { reiniciar: true, motivo: 'pronto' });
});

teste('🚨 IMPRIMINDO nunca reinicia — papel não tem desfazer', () => {
  const r = decidirReinicio({ ...base, imprimindo: true });
  assert.strictEqual(r.reiniciar, false);
  assert.strictEqual(r.motivo, 'imprimindo');
});

teste('🚨 ACK pendente nunca reinicia (o Hub acharia que a etiqueta não saiu)', () => {
  // E aí o pull a reimprimiria na volta — a duplicata de 31/10/2026.
  const r = decidirReinicio({ ...base, acksPendentes: 1 });
  assert.strictEqual(r.reiniciar, false);
  assert.strictEqual(r.motivo, 'acks_pendentes');
});

teste('⚠️ versão NÃO obrigatória não interrompe ninguém', () => {
  // O comportamento de sempre: instala quando a pessoa fechar o programa.
  const r = decidirReinicio({ ...base, obrigatoria: false });
  assert.strictEqual(r.reiniciar, false);
  assert.strictEqual(r.motivo, 'nao_obrigatoria');
});

teste('sem download não há o que instalar', () => {
  const r = decidirReinicio({ ...base, baixado: false });
  assert.strictEqual(r.reiniciar, false);
  assert.strictEqual(r.motivo, 'sem_download');
});

teste('🚨 a ORDEM das guardas: imprimir vence tudo', () => {
  // Com impressão em curso, nem ACK pendente nem nada muda a resposta.
  const r = decidirReinicio({ ...base, imprimindo: true, acksPendentes: 5 });
  assert.strictEqual(r.motivo, 'imprimindo');
});

teste('⚠️ entrada vazia NÃO reinicia (falha fechada)', () => {
  assert.strictEqual(decidirReinicio().reiniciar, false);
  assert.strictEqual(decidirReinicio({}).reiniciar, false);
});

teste('⚠️ acksPendentes como string ou lixo não vira "pode reiniciar"', () => {
  assert.strictEqual(decidirReinicio({ ...base, acksPendentes: '3' }).reiniciar, false);
  assert.strictEqual(decidirReinicio({ ...base, acksPendentes: 'abc' }).reiniciar, true);
});

teste('todo motivo tem frase legível para o log', () => {
  for (const m of ['sem_download', 'nao_obrigatoria', 'imprimindo', 'acks_pendentes', 'pronto']) {
    const f = explicarReinicio(m);
    assert.ok(f && f !== m, `motivo sem frase: ${m}`);
    assert.ok(f.length > 10, `frase curta demais para ${m}: ${f}`);
  }
});

teste('⚠️ a reavaliação é frequente o bastante para pegar a janela ociosa', () => {
  // A expedição imprime em rajadas; esperar 10 min perderia as pausas.
  assert.ok(INTERVALO_DE_TENTATIVA_MS <= 120000, `intervalo longo demais: ${INTERVALO_DE_TENTATIVA_MS}`);
  assert.ok(INTERVALO_DE_TENTATIVA_MS >= 30000, 'intervalo curto demais: consulta o estado à toa');
});

for (const [nome, fn] of casos) {
  try { fn(); passaram++; console.log(`  ✓ ${nome}`); }
  catch (erro) { console.error(`  ✗ ${nome}\n    ${erro.message}`); process.exitCode = 1; }
}
console.log(`\n${passaram}/${casos.length} casos`);
