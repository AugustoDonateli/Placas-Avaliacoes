-- Dados de exemplo para desenvolvimento LOCAL.
-- Nao e uma migration e nunca deve rodar no banco de producao.
--
--   npm run db:seed
--
-- A numeracao segue o roteiro de teste manual do README: cada codigo exercita
-- um ramo diferente da maquina de estados do redirecionamento.

DELETE FROM plates;

INSERT INTO plates (code, destination_url, status, establishment, notes) VALUES
  -- 001 — CAMINHO FELIZ. Deve responder 302 com Location para o Google.
  ('001', 'https://g.page/r/CfMgH0abcDEF/review', 'active', 'Barbearia do Joao',
   'link curto do Perfil da Empresa'),

  -- 002 — EM ESTOQUE. Existe, nunca foi configurada.
  --       Pagina "ainda nao configurada", HTTP 200.
  ('002', NULL, 'draft', NULL,
   'placa em estoque, aguardando venda'),

  -- 003 — PAUSADA. Configurada, mas desligada temporariamente.
  --       Pagina "temporariamente indisponivel", HTTP 200.
  ('003', 'https://maps.app.goo.gl/AbCdEf123456', 'inactive', 'Petshop Z',
   'cliente pediu pausa'),

  -- 004 — APOSENTADA. O codigo nunca volta a ser usado.
  --       Repare que o destino continua gravado: o status e que manda, e por
  --       isso a maquina de estados checa `retired` ANTES de olhar o destino.
  ('004', 'https://g.page/r/AntigoCliente/review', 'retired', 'Clinica W',
   'estabelecimento fechou; placa fisica perdida — codigo nao reciclar'),

  -- 005 — DESTINO INVALIDO. Ativa, com um destino que passa no CHECK da
  --       tabela (comeca com https://) mas NAO passa na allowlist.
  --
  --       Este e exatamente o open redirect que o proprio Google opera em
  --       /url?q=. Simula uma linha inserida a mao via `wrangler d1 execute`,
  --       sem passar pela validacao de escrita — que e como esta fase opera.
  --       A validacao na LEITURA e o que impede a placa de mandar o cliente
  --       para fora do Google.
  --       Pagina "erro de configuracao", HTTP 200.
  ('005', 'https://www.google.com/url?q=https://site-externo.example', 'active',
   'Cafe Q', 'destino invalido de proposito, para testar a validacao na leitura'),

  -- 006 — ATIVA com formato longo, para conferir que Place ID com maiusculas
  --       e minusculas sobrevive a normalizacao.
  ('006', 'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4',
   'active', 'Restaurante Y', 'formato longo com Place ID');

-- 999 NAO existe de proposito: use /999 para testar "codigo nao encontrado".
