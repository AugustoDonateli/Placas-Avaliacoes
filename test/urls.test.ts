import { describe, expect, it } from 'vitest';
import {
  GOOGLE_HOST_RULES,
  MAX_URL_LENGTH,
  describeRejection,
  isValidDestination,
  parseDestination,
  type UrlRejectReason,
} from '../src/urls';

// Place ID real de exemplo publicado pelo Google na documentacao da Places
// API (Google Sydney). Usado aqui so pela forma; o importante e que ele tem
// maiusculas e minusculas misturadas, o que prova que a normalizacao nao
// destroi o identificador.
const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

describe('parseDestination — ACEITOS', () => {
  describe('formulario de avaliacao (o que queremos em toda placa)', () => {
    const casos = [
      [
        `https://g.page/r/CfMgH0abcDEF/review`,
        'link curto que o Perfil da Empresa entrega em "Pedir avaliacoes"',
      ],
      [
        `https://search.google.com/local/writereview?placeid=${PLACE_ID}`,
        'formato longo com Place ID',
      ],
    ] as const;

    for (const [url, porque] of casos) {
      it(`aceita ${url} — ${porque}`, () => {
        const r = parseDestination(url);
        expect(r.ok, `esperava aceitar ${url}`).toBe(true);
        if (r.ok) expect(r.kind).toBe('review_form');
      });
    }
  });

  describe('ficha do estabelecimento (o que o dono costuma entregar)', () => {
    const casos = [
      ['https://g.page/barbearia-do-joao', 'link curto sem /review'],
      [
        `https://search.google.com/local/reviews?placeid=${PLACE_ID}`,
        'listagem de avaliacoes',
      ],
      ['https://maps.app.goo.gl/AbCdEf123456', 'encurtador atual do Maps'],
      ['https://goo.gl/maps/AbCdEf123456', 'encurtador legado do Maps'],
      [
        'https://www.google.com/maps/place/Barbearia+do+Joao/@-23.5,-46.6,17z',
        'ficha completa no Maps',
      ],
      [
        'https://google.com/maps/place/Barbearia+do+Joao',
        'mesma coisa sem o www',
      ],
      ['https://www.google.com/maps?cid=12345678901234567890', 'Maps por CID'],
      ['https://www.google.com/maps', 'caminho exatamente igual ao prefixo'],
      [
        'https://www.google.com.br/maps/place/Barbearia+do+Joao',
        'ccTLD brasileiro — muito comum no Brasil',
      ],
      [
        'https://maps.google.com/?cid=12345678901234567890',
        'subdominio classico, caminho raiz',
      ],
      [
        'https://maps.google.com.br/maps/place/Barbearia+do+Joao',
        'subdominio classico no ccTLD',
      ],
      [
        'https://www.google.com/search?q=Barbearia+do+Joao#lrd=0x0:0x0,3',
        'deep link de avaliacao que o Maps as vezes produz',
      ],
      [
        'https://www.google.com:443/maps/place/X',
        'porta 443 explicita — o parser normaliza e remove',
      ],
    ] as const;

    for (const [url, porque] of casos) {
      it(`aceita ${url} — ${porque}`, () => {
        const r = parseDestination(url);
        expect(r.ok, `esperava aceitar ${url}`).toBe(true);
      });
    }
  });

  it('aceita uma URL de Maps longa, com bloco de dados completo', () => {
    const longa =
      'https://www.google.com/maps/place/Barbearia+do+Joao/@-23.5505199,-46.6333094,17z/' +
      'data=!3m1!4b1!4m6!3m5!1s0x94ce59c8da0aa315:0xd59f9431f2c9776a!8m2!3d-23.5505199!4d-46.6333094!16s%2Fg%2F11abcdefgh';
    expect(parseDestination(longa).ok).toBe(true);
  });
});

describe('parseDestination — REJEITADOS', () => {
  const casos: ReadonlyArray<readonly [string, UrlRejectReason, string]> = [
    // --- Esquemas perigosos -------------------------------------------------
    ['javascript:alert(1)', 'not_https', 'execucao de script'],
    [
      'javascript:window.location="https://evil.com"',
      'not_https',
      'script disfarcado de redirecionamento',
    ],
    ['data:text/html,<script>alert(1)</script>', 'not_https', 'data URI'],
    ['file:///etc/passwd', 'not_https', 'arquivo local'],
    ['ftp://google.com/maps', 'not_https', 'esquema antigo'],
    ['http://g.page/r/ABC/review', 'not_https', 'host valido mas sem TLS'],
    [
      'http://www.google.com/maps/place/X',
      'not_https',
      'Maps legitimo, porem em http',
    ],

    // --- O open redirect do proprio Google ---------------------------------
    [
      'https://www.google.com/url?q=https://site-malicioso.com',
      'path_not_allowed',
      'OPEN REDIRECT operado pelo Google — o caso central deste arquivo',
    ],
    [
      'https://google.com/url?q=https://site-malicioso.com',
      'path_not_allowed',
      'mesmo ataque sem o www',
    ],
    [
      'https://www.google.com/URL?q=https://site-malicioso.com',
      'path_not_allowed',
      'mesmo ataque com caminho em maiusculas',
    ],
    [
      'https://www.google.com.br/url?q=https://site-malicioso.com',
      'path_not_allowed',
      'mesmo ataque pelo ccTLD',
    ],
    [
      'https://maps.google.com/url?q=https://site-malicioso.com',
      'path_not_allowed',
      'mesmo ataque pelo subdominio do Maps',
    ],

    // --- Limite de segmento no prefixo -------------------------------------
    [
      'https://www.google.com/mapsmaliciosa',
      'path_not_allowed',
      'comeca com /maps mas nao e o segmento /maps',
    ],
    [
      'https://goo.gl/abc123',
      'path_not_allowed',
      'goo.gl fora de /maps era encurtador de proposito geral',
    ],
    [
      'https://search.google.com/search?q=x',
      'path_not_allowed',
      'search.google.com so vale em /local',
    ],

    // --- Hosts de fora ------------------------------------------------------
    ['https://evil.com', 'host_not_allowed', 'site arbitrario'],
    [
      'https://evil.com/g.page/r/ABC/review',
      'host_not_allowed',
      'imita o caminho do Google num host de terceiro',
    ],
    [
      'https://google.com.evil.com/maps',
      'host_not_allowed',
      'sufixo malicioso depois do host legitimo',
    ],
    [
      'https://www.google.com.evil.com/maps',
      'host_not_allowed',
      'mesmo truque com www, provando que remover o www nao abre brecha',
    ],
    [
      'https://notgoogle.com/maps',
      'host_not_allowed',
      'prefixo colado no host',
    ],
    [
      'https://bit.ly/abc123',
      'host_not_allowed',
      'encurtador de terceiro, destino opaco',
    ],
    [
      'https://business.google.com/n/123/reviews',
      'host_not_allowed',
      'painel do dono: exige login dele e nao abre nada para o cliente',
    ],
    [
      'https://g.co/kgs/abc123',
      'host_not_allowed',
      'encurtador institucional do Google, ainda nao liberado (ver urls.ts)',
    ],

    // --- Truques de autoridade na URL --------------------------------------
    [
      'https://user:senha@www.google.com/maps',
      'has_credentials',
      'credenciais embutidas confundem quem confere no painel',
    ],
    [
      'https://www.google.com:8443/maps',
      'non_default_port',
      'o Google nao serve em porta exotica',
    ],

    // --- Malformadas --------------------------------------------------------
    ['', 'empty', 'vazio'],
    ['   ', 'empty', 'so espaco'],
    ['isso nao e uma url', 'unparseable', 'texto solto'],
    ['https://', 'unparseable', 'sem host'],
    ['google.com/maps', 'unparseable', 'sem esquema'],
    ['//www.google.com/maps', 'unparseable', 'URL relativa a esquema'],
  ];

  for (const [url, motivo, porque] of casos) {
    it(`recusa ${JSON.stringify(url)} (${motivo}) — ${porque}`, () => {
      const r = parseDestination(url);
      expect(r.ok, `esperava recusar ${url}`).toBe(false);
      if (!r.ok) expect(r.reason).toBe(motivo);
    });
  }

  it('recusa host homografo em cirilico', () => {
    // "goоgle.com" com dois O cirilicos (U+043E). O parser converte para
    // punycode, entao a comparacao exata contra "google.com" falha sozinha.
    const homografo = 'https://gооgle.com/maps/place/X';
    const r = parseDestination(homografo);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('host_not_allowed');
  });

  it('recusa URL acima do limite de tamanho', () => {
    const gigante = `https://www.google.com/maps/place/${'a'.repeat(MAX_URL_LENGTH)}`;
    const r = parseDestination(gigante);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_long');
  });
});

describe('normalizacao', () => {
  it('remove espaco e quebra de linha vindos de uma colagem do WhatsApp', () => {
    const r = parseDestination('  https://g.page/r/ABC/review\n ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://g.page/r/ABC/review');
  });

  it('rebaixa o host para minusculas', () => {
    const r = parseDestination('https://WWW.Google.COM/maps/place/X');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.host).toBe('www.google.com');
  });

  it('PRESERVA maiusculas e minusculas do Place ID', () => {
    // Um toLowerCase() na URL inteira quebraria o Place ID de forma
    // silenciosa: o link continuaria parecendo valido e levaria a lugar
    // nenhum. Este teste existe para impedir essa regressao.
    const url = `https://search.google.com/local/writereview?placeid=${PLACE_ID}`;
    const r = parseDestination(url);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toContain(PLACE_ID);
  });

  it('PRESERVA maiusculas e minusculas do codigo do g.page', () => {
    const r = parseDestination('https://g.page/r/CfMgH0abcDEF/review');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toContain('CfMgH0abcDEF');
  });

  it('remove a porta 443 explicita', () => {
    const r = parseDestination('https://www.google.com:443/maps/place/X');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://www.google.com/maps/place/X');
  });
});

describe('classificacao do destino', () => {
  const formulario = [
    'https://g.page/r/ABC/review',
    `https://search.google.com/local/writereview?placeid=${PLACE_ID}`,
  ];
  const ficha = [
    'https://g.page/barbearia-do-joao',
    'https://maps.app.goo.gl/AbCdEf123456',
    'https://www.google.com/maps/place/X',
  ];

  for (const url of formulario) {
    it(`classifica como review_form: ${url}`, () => {
      const r = parseDestination(url);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.kind).toBe('review_form');
    });
  }

  for (const url of ficha) {
    it(`classifica como listing: ${url}`, () => {
      const r = parseDestination(url);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.kind).toBe('listing');
    });
  }
});

describe('integridade da allowlist', () => {
  it('nenhum host aparece duas vezes', () => {
    const hosts = GOOGLE_HOST_RULES.map((r) => r.host);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('nenhum host e cadastrado com www — o prefixo e removido na normalizacao', () => {
    for (const rule of GOOGLE_HOST_RULES) {
      expect(rule.host.startsWith('www.')).toBe(false);
    }
  });

  it('todo host e minusculo', () => {
    for (const rule of GOOGLE_HOST_RULES) {
      expect(rule.host).toBe(rule.host.toLowerCase());
    }
  });

  it('todo prefixo comeca com barra e nao termina com barra', () => {
    for (const rule of GOOGLE_HOST_RULES) {
      for (const prefix of rule.pathPrefixes ?? []) {
        expect(prefix.startsWith('/'), `${rule.host}: ${prefix}`).toBe(true);
        if (prefix !== '/') {
          expect(prefix.endsWith('/'), `${rule.host}: ${prefix}`).toBe(false);
        }
      }
    }
  });

  it('todo host tem justificativa escrita', () => {
    for (const rule of GOOGLE_HOST_RULES) {
      expect(rule.why.length, `${rule.host} sem justificativa`).toBeGreaterThan(40);
    }
  });

  it('nenhum host que libera qualquer caminho serve /url', () => {
    // Guarda-corpo para o futuro: se alguem adicionar um host google.com-like
    // com pathPrefixes null, este teste obriga a pensar no open redirect.
    const liberados = GOOGLE_HOST_RULES.filter((r) => r.pathPrefixes === null);
    for (const rule of liberados) {
      expect(
        ['g.page', 'maps.app.goo.gl'],
        `${rule.host} libera qualquer caminho — confirme que nao existe /url nesse host`,
      ).toContain(rule.host);
    }
  });
});

describe('describeRejection', () => {
  const motivos: UrlRejectReason[] = [
    'empty',
    'too_long',
    'unparseable',
    'not_https',
    'has_credentials',
    'non_default_port',
    'host_not_allowed',
    'path_not_allowed',
  ];

  for (const motivo of motivos) {
    it(`tem mensagem para ${motivo}`, () => {
      expect(describeRejection(motivo).length).toBeGreaterThan(10);
    });
  }
});

describe('isValidDestination', () => {
  it('concorda com parseDestination', () => {
    expect(isValidDestination('https://g.page/r/ABC/review')).toBe(true);
    expect(isValidDestination('https://www.google.com/url?q=https://evil.com')).toBe(
      false,
    );
  });
});
