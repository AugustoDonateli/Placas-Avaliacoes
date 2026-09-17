import { describe, expect, it } from 'vitest';
import {
  MAX_CODE_LENGTH,
  RESERVED_CODES,
  isValidCode,
  normalizeCode,
  parseCode,
} from '../src/codes';

describe('normalizeCode', () => {
  it('remove espaco em volta', () => {
    expect(normalizeCode('  001  ')).toBe('001');
  });

  it('rebaixa para minusculas', () => {
    expect(normalizeCode('A7K2')).toBe('a7k2');
  });

  it('aceita um pathname cru, com barras', () => {
    expect(normalizeCode('/001')).toBe('001');
    expect(normalizeCode('001/')).toBe('001');
    expect(normalizeCode('/001/')).toBe('001');
  });

  it('nao confunde caminho de varios segmentos com codigo', () => {
    // Continua com a barra do meio, entao parseCode vai recusar.
    expect(normalizeCode('/a/b/')).toBe('a/b');
  });
});

describe('parseCode — aceitos', () => {
  const aceitos = [
    ['001', 'o formato em uso hoje'],
    ['002', 'sequencial'],
    ['010', 'com zero no meio'],
    ['999', 'ultimo de tres digitos'],
    ['1000', 'quatro digitos, quando passar de 999'],
    ['1', 'um digito'],
    ['a7k2', 'formato alfanumerico curto, caso mude no futuro'],
    ['abcdefghijkl', `exatamente ${MAX_CODE_LENGTH} caracteres`],
  ] as const;

  for (const [code, porque] of aceitos) {
    it(`aceita "${code}" — ${porque}`, () => {
      const r = parseCode(code);
      expect(r.ok, `esperava aceitar ${code}`).toBe(true);
      if (r.ok) expect(r.code).toBe(code);
    });
  }

  it('normaliza antes de validar', () => {
    const r = parseCode('  /A7K2/  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.code).toBe('a7k2');
  });
});

describe('parseCode — recusados', () => {
  const recusados = [
    ['', 'empty', 'string vazia'],
    ['   ', 'empty', 'so espaco'],
    ['/', 'empty', 'so barra'],
    ['abcdefghijklm', 'too_long', `${MAX_CODE_LENGTH + 1} caracteres`],
    ['a-b', 'invalid_chars', 'hifen'],
    ['a_b', 'invalid_chars', 'underline'],
    ['a b', 'invalid_chars', 'espaco no meio'],
    ['a.b', 'invalid_chars', 'ponto'],
    ['a/b', 'invalid_chars', 'varios segmentos'],
    ['..', 'invalid_chars', 'travessia de diretorio'],
    ['%2e%2e', 'invalid_chars', 'travessia percent-encoded'],
    ['café', 'invalid_chars', 'acento combinante'],
    ['ção', 'invalid_chars', 'acento'],
    ['00 1', 'invalid_chars', 'espaco interno'],
  ] as const;

  for (const [entrada, motivo, porque] of recusados) {
    it(`recusa ${JSON.stringify(entrada)} (${motivo}) — ${porque}`, () => {
      const r = parseCode(entrada);
      expect(r.ok, `esperava recusar ${JSON.stringify(entrada)}`).toBe(false);
      if (!r.ok) expect(r.reason).toBe(motivo);
    });
  }
});

describe('parseCode — caminhos reservados', () => {
  for (const reservado of RESERVED_CODES) {
    it(`recusa "${reservado}"`, () => {
      const r = parseCode(reservado);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('reserved');
    });
  }

  it('recusa reservado mesmo em maiusculas, porque normaliza antes', () => {
    const r = parseCode('ADMIN');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('reserved');
  });

  it('distingue reservado de malformado, para o roteamento poder tratar diferente', () => {
    const reservado = parseCode('api');
    const malformado = parseCode('a-b');
    expect(reservado.ok).toBe(false);
    expect(malformado.ok).toBe(false);
    if (!reservado.ok && !malformado.ok) {
      expect(reservado.reason).toBe('reserved');
      expect(malformado.reason).toBe('invalid_chars');
    }
  });
});

describe('isValidCode', () => {
  it('concorda com parseCode', () => {
    expect(isValidCode('001')).toBe(true);
    expect(isValidCode('admin')).toBe(false);
  });
});
