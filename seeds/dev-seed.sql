-- Dados de exemplo para desenvolvimento LOCAL.
-- Nao e uma migration e nunca deve rodar no banco de producao.
--
--   npm run db:seed
--
-- Cobre os quatro status, para que a maquina de estados do redirecionamento
-- (etapa 3) possa ser testada sem cadastrar nada a mao.

DELETE FROM plates;

INSERT INTO plates (code, destination_url, status, establishment, notes) VALUES
  -- Caminho feliz: deve responder 302 para o destino.
  ('001', 'https://g.page/r/CODIGO_DE_EXEMPLO/review', 'active',   'Barbearia do Joao',  'link curto do Perfil da Empresa'),
  ('002', 'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4', 'active', 'Restaurante Y', 'formato longo com Place ID'),

  -- Em estoque: existe, nunca configurada. Pagina "ainda nao configurada".
  ('003', NULL, 'draft', NULL, NULL),
  ('004', NULL, 'draft', NULL, NULL),

  -- Pausada: pagina "temporariamente indisponivel".
  ('005', 'https://maps.app.goo.gl/EXEMPLO', 'inactive', 'Petshop Z', 'cliente pediu pausa'),

  -- Aposentada: codigo nunca sera reutilizado.
  ('006', NULL, 'retired', 'Clinica W', 'estabelecimento fechou; placa fisica perdida'),

  -- Configurada mas com status draft: o destino NAO deve ser usado.
  ('007', 'https://g.page/r/OUTRO_EXEMPLO/review', 'draft', 'Cafe Q', 'preparada, ainda nao entregue');

-- O codigo 999 NAO existe de proposito: use /999 para testar "nao encontrado".
