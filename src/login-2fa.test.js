/**
 * As LIGAÇÕES do login em duas etapas — `node src/login-2fa.test.js`.
 *
 * A regra de leitura da resposta tem teste próprio (`resposta-de-login.test.js`).
 * Aqui ficam as amarrações entre main.js, preload.js e a tela: é nelas que
 * esse recurso quebra sem erro — um canal que não foi exposto, um `store.set`
 * que não aconteceu, um cabeçalho que não foi enviado. O sintoma seria o 2FA
 * sendo pedido todo dia, ou a tela pedindo um código que nunca chega.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const tela = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);
const semComentarios = (txt) => txt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

teste('🚨 o login NÃO lê `.token.token` direto (a causa do erro na tela)', () => {
  const codigo = semComentarios(main);
  assert.ok(
    !/data\.token\.token/.test(codigo),
    'voltou a ler o token direto: conta com 2FA quebra com "Cannot read properties of undefined"',
  );
  assert.ok(codigo.includes('interpretarLogin('), 'o login não usa a regra de leitura testada');
});

teste('🚨 o login manda o aparelho confiável no cabeçalho', () => {
  assert.ok(main.includes("'x-trusted-device'"), 'sem o cabeçalho, o 2FA é pedido em TODO login');
  assert.ok(main.includes("store.get('trusted_device')"));
});

teste('🚨 a sessão GUARDA o token do aparelho confiável', () => {
  assert.ok(
    main.includes("store.set('trusted_device', sessao.dispositivoConfiavel)"),
    'sem guardar, o recurso não existe: o Hub devolve o token e nós o jogamos fora',
  );
});

teste('🚨 a verificação pede para confiar no aparelho', () => {
  assert.ok(
    /confiar_dispositivo:\s*true/.test(main),
    'sem isto o Hub não emite o token de aparelho e o código volta a ser diário',
  );
});

teste('⚠️ `concluirLogin` é ponto ÚNICO — os dois caminhos passam por ele', () => {
  const ocorrencias = (main.match(/await concluirLogin\(/g) || []).length;
  assert.strictEqual(ocorrencias, 2, `esperava 2 chamadas (senha e código), achei ${ocorrencias}`);
  // E é ele quem registra o agente e conecta — não pode haver caminho que pule isso.
  const corpo = main.slice(main.indexOf('async function concluirLogin'), main.indexOf("let desafioEmCurso"));
  assert.ok(corpo.includes('registrarAgente('), 'concluirLogin não registra o agente');
  assert.ok(corpo.includes('conectarMqtt('), 'concluirLogin não conecta o MQTT');
});

teste('os canais do segundo fator estão expostos no preload', () => {
  assert.ok(preload.includes("invoke('login-codigo'"), 'canal do código não exposto');
  assert.ok(preload.includes("invoke('login-reenviar-codigo'"), 'canal de reenvio não exposto');
  // E existem do lado de lá.
  assert.ok(main.includes("ipcMain.handle('login-codigo'"));
  assert.ok(main.includes("ipcMain.handle('login-reenviar-codigo'"));
});

teste('a tela tem a etapa do código, escondida até ser pedida', () => {
  assert.ok(tela.includes('id="etapa-codigo"'));
  assert.ok(/id="etapa-codigo"[^>]*style="display:none"/.test(tela), 'a etapa nasce visível');
  assert.ok(tela.includes('window.hub.loginCodigo('), 'a tela não chama a verificação');
});

teste('⚠️ a conta sem 2FA configurado vira INSTRUÇÃO, não exceção', () => {
  assert.ok(main.includes('mensagemDeConfiguracao('), 'o caso `mfa_setup_required` não é tratado');
});

teste('⚠️ o desafio expirado devolve a pessoa para a senha', () => {
  assert.ok(tela.includes('if (res.expirou) voltarParaSenha()'),
    'sem isto a pessoa fica digitando código num desafio morto');
});

teste('a tela avisa que o computador será lembrado', () => {
  // O recurso só é entendido se for dito: quem opera precisa saber por que o
  // código não aparece amanhã.
  assert.ok(/lembrado/i.test(tela));
});

for (const [nome, fn] of casos) {
  try { fn(); passaram++; console.log(`  ✓ ${nome}`); }
  catch (erro) { console.error(`  ✗ ${nome}\n    ${erro.message}`); process.exitCode = 1; }
}
console.log(`\n${passaram}/${casos.length} casos`);
