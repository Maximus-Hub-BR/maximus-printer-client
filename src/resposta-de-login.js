/**
 * O que o `/auth/login` respondeu — regra pura, sem rede e sem Electron.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 "Cannot read properties of undefined (reading 'token')" (30/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Era o que a tela mostrava ao tentar entrar com uma conta de pessoa. O
 * cliente fazia `res.data.data.token.token` direto, e o Hub tem **TRÊS**
 * respostas possíveis para o login desde que o 2FA entrou:
 *
 *   1. `{ token: { token }, user }`                    → sessão pronta;
 *   2. `{ mfa_required, challenge, metodos, ... }`      → falta o código;
 *   3. `{ mfa_setup_required, setup_token, ... }`      → a conta nunca
 *      configurou o segundo fator e a carência venceu.
 *
 * As duas últimas não têm `token`, e o cliente estourava no `.token` de
 * `undefined` — uma mensagem que não diz nada a quem está no balcão tentando
 * imprimir. Pior: o Hub **aceitava** aquela credencial; quem recusava era o
 * nosso código, por não saber ler a resposta.
 *
 * ⚠️ Esta função NÃO decide o que fazer, só diz O QUE VEIO. A decisão (pedir
 * código, mandar configurar no Hub) fica em quem tem a tela.
 */

/**
 * @param {object} corpo  o `data` da resposta do Hub
 * @returns {{tipo: 'sessao'|'codigo'|'configurar'|'desconhecido', ...}}
 */
function interpretarLogin(corpo) {
  const d = corpo && typeof corpo === 'object' ? corpo : {};

  // ⚠️ A ordem importa: uma resposta de sessão nunca traz `mfa_required`, mas
  // ler o token PRIMEIRO protege contra um campo novo do servidor mudar o
  // caminho de quem já estava entrando.
  const token = d.token && typeof d.token === 'object' ? d.token.token : undefined;
  if (typeof token === 'string' && token) {
    return {
      tipo: 'sessao',
      token,
      usuario: d.user || null,
      // Só vem quando a verificação acabou de acontecer e o cliente pediu
      // para confiar no aparelho.
      dispositivoConfiavel: d.trusted_device && d.trusted_device.token ? d.trusted_device.token : null,
    };
  }

  if (d.mfa_required === true && typeof d.challenge === 'string' && d.challenge) {
    return {
      tipo: 'codigo',
      desafio: d.challenge,
      expiraEmMin: Number(d.expira_em_min) || null,
      /*
       * ⚠️ `metodos` diz COMO a pessoa recebe o código. O app (TOTP) não
       * precisa de envio; e-mail e WhatsApp precisam de um "enviar agora".
       * Sem essa distinção, a tela ou mostra um botão que não faz nada, ou
       * esconde o botão de quem depende dele para entrar.
       */
      metodos: Array.isArray(d.metodos) ? d.metodos : [],
      backupDisponiveis: Number(d.backup_disponiveis) || 0,
    };
  }

  if (d.mfa_setup_required === true) {
    return {
      tipo: 'configurar',
      setupToken: typeof d.setup_token === 'string' ? d.setup_token : null,
      podeAdiar: d.pode_adiar === true,
      prazoAte: d.prazo_ate || null,
      canais: Array.isArray(d.canais_disponiveis) ? d.canais_disponiveis : [],
    };
  }

  return { tipo: 'desconhecido' };
}

/** Os métodos que precisam de um envio ativo (o do app, não). */
function metodosQuePrecisamEnvio(metodos) {
  return (metodos || []).filter((m) => {
    const tipo = String((m && (m.type || m.tipo)) || '').toLowerCase();
    return tipo === 'email' || tipo === 'whatsapp' || tipo === 'sms';
  });
}

/**
 * A frase para quem está no balcão quando a conta não tem segundo fator.
 *
 * ⚠️ O Print Client **não configura 2FA**, de propósito: é app de balcão, a
 * máquina costuma ser compartilhada e não há onde guardar um segredo de
 * autenticação de pessoa com segurança. Quem configura é o Hub, no navegador.
 * O que o cliente faz é dizer isso de um jeito que leve a pessoa ao lugar
 * certo — em vez de "Cannot read properties of undefined".
 */
function mensagemDeConfiguracao(resultado) {
  if (resultado && resultado.podeAdiar) {
    return (
      'Esta conta ainda não configurou a verificação em duas etapas. ' +
      'Você pode adiar por enquanto e entrar — mas configure no Hub, em Configurações › Segurança.'
    );
  }
  return (
    'Esta conta precisa configurar a verificação em duas etapas antes de entrar. ' +
    'Abra o Hub no navegador, vá em Configurações › Segurança e conclua a configuração; ' +
    'depois volte aqui. Para um computador de balcão, o ideal é usar uma conta de impressão ' +
    'própria — fale com o suporte.'
  );
}

module.exports = { interpretarLogin, metodosQuePrecisamEnvio, mensagemDeConfiguracao };
