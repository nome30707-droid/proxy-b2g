# Proxy B2G Fornecedores

Backend que consulta fontes governamentais reais + IA para recomendar fornecedores.

## Fontes consultadas automaticamente

| Fonte | O que busca | Autenticação |
|-------|-------------|--------------|
| **PNCP** (pncp.gov.br) | Contratações e atas de registro de preço vigentes | Pública, sem login |
| **Compras.gov.br** (dados.gov.br) | Licitações e fornecedores homologados no SIASG | Pública, sem login |
| **Mercado Livre / Web** | Preço de mercado atual (via busca IA) | Pública |

## Deploy no Railway (gratuito, ~5 minutos)

1. Acesse https://railway.app → crie conta gratuita
2. "New Project" → "Deploy from GitHub"
   - Faça upload ou clone desta pasta
3. Em "Variables", adicione:
   ```
   ANTHROPIC_API_KEY=sk-ant-...sua chave...
   ```
4. Aguarde o deploy — Railway gera uma URL como:
   ```
   https://b2g-proxy-production.up.railway.app
   ```
5. Cole essa URL no campo do widget

## Deploy no Render (alternativa gratuita)

1. https://render.com → New Web Service
2. Conecte o repositório
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Environment Variable: `ANTHROPIC_API_KEY=sk-ant-...`

## Onde pegar a ANTHROPIC_API_KEY

1. Acesse https://console.anthropic.com
2. Menu "API Keys" → "Create Key"
3. Copie e cole na variável de ambiente do servidor

## Teste local

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
# Acesse http://localhost:3000
```

## Como funciona

```
Widget → POST /api/buscar → Proxy
                               ├─ PNCP API (contratações recentes)
                               ├─ PNCP API (atas de registro de preço)
                               ├─ Compras.gov.br API (licitações SIASG)
                               ├─ Compras.gov.br API (fornecedores)
                               └─ Claude IA (analisa dados + busca ML/web)
                                        └─ Retorna JSON com ranking
```
