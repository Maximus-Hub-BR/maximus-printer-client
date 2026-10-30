/**
 * As três respostas do login — `node src/resposta-de-login.test.js`.
 *
 * Cada caso corresponde a uma forma real de o login terminar, e o primeiro
 * deles é o erro que a tela mostrava em 30/10/2026: "Cannot read properties
 * of undefined (reading 'token')".
 */
const assert = require('assert');
const {
  interpretarLogin,
  metodosQuePrecisamEnvio,
  mensagemDeConfiguracao,
} = require('./resposta-de-login');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

teste('sessão pronta: devolve o token e o usuário', () => {
  const r = interpretarLogin({ token: { token: 'jwt-123' }, user: { id: 11, name: 'Diva' } });
  assert.strictEqual(r.tipo, 'sessao');
  assert.strictEqual(r.token, 'jwt-123');
  assert.strictEqual(r.usuario.id, 11);
});

teste('🚨 2FA pedido: NÃO estoura no `.token` de undefined', () => {
  const corpo = { mfa_required: true, challenge: 'abc', expira_em_min: 10, metodos: [], backup_disponiveis: 3 };
  assert.doesNotThrow(() => interpretarLogin(corpo));
  const r = interpretarLogin(corpo);
  assert.strictEqual(r.tipo, 'codigo');
  assert.strictEqual(r.desafio, 'abc');
  assert.strictEqual(r.expiraEmMin, 10);
  assert.strictEqual(r.backupDisponiveis, 3);
});

teste('🚨 conta sem 2FA configurado: vira instrução, não exceção', () => {
  const corpo = { mfa_setup_required: true, setup_token: 'st-1', pode_adiar: false, canais_disponiveis: ['email'] };
  const r = interpretarLogin(corpo);
  assert.strictEqual(r.tipo, 'configurar');
  assert.strictEqual(r.setupToken, 'st-1');
  assert.strictEqual(r.podeAdiar, false);
  assert.ok(mensagemDeConfiguracao(r).includes('Configurações'));
});

teste('o token do dispositivo confiável é devolvido quando vem', () => {
  const r = interpretarLogin({ token: { token: 'j' }, trusted_device: { token: 'td-9', dias: 30 } });
  assert.strictEqual(r.dispositivoConfiavel, 'td-9');
});

teste('sessão sem trusted_device devolve null, nunca undefined', () => {
  const r = interpretarLogin({ token: { token: 'j' } });
  assert.strictEqual(r.dispositivoConfiavel, null);
});

teste('⚠️ resposta vazia/estranha NÃO vira sessão', () => {
  for (const corpo of [null, undefined, {}, { token: null }, { token: {} }, { token: { token: '' } }, 'texto']) {
    assert.strictEqual(interpretarLogin(corpo).tipo, 'desconhecido', `virou sessão: ${JSON.stringify(corpo)}`);
  }
});

teste('⚠️ mfa_required sem challenge não é tratado como código', () => {
  // Sem o desafio não há o que verificar: melhor cair no erro genérico do que
  // abrir uma tela de código que nunca vai funcionar.
  assert.strictEqual(interpretarLogin({ mfa_required: true }).tipo, 'desconhecido');
});

teste('métodos que precisam de envio: e-mail e WhatsApp sim, app não', () => {
  const metodos = [
    { id: 1, type: 'totp' },
    { id: 2, type: 'email' },
    { id: 3, type: 'whatsapp' },
  ];
  const precisam = metodosQuePrecisamEnvio(metodos);
  assert.deepStrictEqual(precisam.map((m) => m.id), [2, 3]);
});

teste('métodos aceita `tipo` em português também', () => {
  assert.strictEqual(metodosQuePrecisamEnvio([{ id: 7, tipo: 'EMAIL' }]).length, 1);
});

teste('lista de métodos ausente não quebra', () => {
  assert.deepStrictEqual(metodosQuePrecisamEnvio(undefined), []);
  assert.deepStrictEqual(interpretarLogin({ mfa_required: true, challenge: 'x' }).metodos, []);
});

teste('⚠️ a mensagem muda quando a pessoa PODE adiar', () => {
  const comAdiamento = mensagemDeConfiguracao({ podeAdiar: true });
  const sem = mensagemDeConfiguracao({ podeAdiar: false });
  assert.ok(comAdiamento.includes('adiar'));
  assert.ok(!sem.includes('pode adiar'));
  // Em ambos a pessoa fica sabendo PARA ONDE ir.
  for (const m of [comAdiamento, sem]) assert.ok(m.includes('Hub'), m);
});

for (const [nome, fn] of casos) {
  try { fn(); passaram++; console.log(`  ✓ ${nome}`); }
  catch (erro) { console.error(`  ✗ ${nome}\n    ${erro.message}`); process.exitCode = 1; }
}
console.log(`\n${passaram}/${casos.length} casos`);
