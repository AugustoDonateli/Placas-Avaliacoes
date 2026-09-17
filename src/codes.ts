/**
 * Validacao e normalizacao do codigo publico da placa.
 *
 * O codigo e o que esta impresso no QR e gravado na tag NFC:
 *
 *     SEUDOMINIO.com/001
 *                    ^^^
 *
 * Ele e IMUTAVEL. Uma vez que a placa sai da bancada, aquele codigo pertence
 * aquela placa para sempre. Por isso as regras aqui sao conservadoras: e muito
 * mais barato recusar um codigo estranho hoje do que descobrir daqui a um ano
 * que trezentas placas impressas usam um formato que o sistema nao aceita.
 */

/** Limite de tamanho do codigo. Generoso: hoje usamos 3 digitos. */
export const MAX_CODE_LENGTH = 12;

/**
 * Apenas minusculas e digitos.
 *
 * Sem hifen, sem underline, sem acento: o codigo e lido em voz alta ao
 * telefone ("zero zero um") e digitado a mao por quem nao conseguiu escanear.
 * Todo caractere que exige explicacao e um caractere a menos de confiabilidade.
 */
const CODE_PATTERN = /^[a-z0-9]+$/;

/**
 * Caminhos que a aplicacao usa para si e que portanto nunca podem ser o
 * codigo de uma placa.
 *
 * Hoje os codigos sao numericos e nenhuma colisao e possivel. A lista existe
 * para o dia em que o formato mudar para letras — momento em que uma placa
 * `admin` impressa seria um problema sem conserto, porque o QR ja estaria
 * na mao do cliente.
 */
export const RESERVED_CODES: readonly string[] = [
  'admin',
  'api',
  'app',
  'assets',
  'contato',
  'favicon',
  'login',
  'logout',
  'privacidade',
  'robots',
  'sitemap',
  'sobre',
  'static',
  'termos',
  'www',
];

export type CodeRejectReason =
  | 'empty'
  | 'too_long'
  | 'invalid_chars'
  | 'reserved';

export type ParsedCode =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: CodeRejectReason };

/**
 * Deixa a entrada na forma canonica: minuscula, sem espaco em volta e sem as
 * barras que vem de um pathname.
 *
 * Aceita tanto `001` quanto `/001/`, para que a camada de roteamento possa
 * entregar o pathname cru sem tratamento previo.
 *
 * Minusculas importam: quando o formato do codigo passar a ter letras,
 * `/A7K2` digitado a mao precisa chegar no mesmo lugar que `/a7k2`.
 */
export function normalizeCode(raw: string): string {
  return raw.trim().replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Normaliza e valida. O resultado diz o motivo exato da recusa, para que o
 * roteamento possa responder de forma diferente a um codigo malformado e a
 * um caminho reservado.
 */
export function parseCode(raw: string): ParsedCode {
  const code = normalizeCode(raw);

  if (code.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  // Tamanho antes do formato: um codigo longo demais com caracteres validos
  // deve reportar 'too_long', que e a informacao util.
  if (code.length > MAX_CODE_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  if (!CODE_PATTERN.test(code)) {
    return { ok: false, reason: 'invalid_chars' };
  }
  if (RESERVED_CODES.includes(code)) {
    return { ok: false, reason: 'reserved' };
  }

  return { ok: true, code };
}

/** Atalho para quando so interessa o sim/nao. */
export function isValidCode(raw: string): boolean {
  return parseCode(raw).ok;
}
