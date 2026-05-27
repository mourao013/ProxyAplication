/**
 * Web Proxy com Controle de Conteúdo
 * Sistemas para Internet 2 — FURG 2026/1
 *
 * Funcionalidades:
 *  - Modo transparente: repassa conteúdo sem modificações
 *  - Bloqueio de sites:  retorna página personalizada para domínios bloqueados
 *  - Filtro de palavrões: substitui palavras no HTML antes de entregar ao cliente
 *  - Log de acessos: registra cada requisição em log.json
 *  - (Bônus) Suporte ao método CONNECT para tunelamento HTTPS
 */

const http    = require('http');
const https   = require('https');
const net     = require('net');
const fs      = require('fs');
const path    = require('path');

// ─── Configurações ────────────────────────────────────────────────────────────

const PORT         = 5000;
const BLOCKED_FILE = path.join(__dirname, 'blocked.json');
const WORDS_FILE   = path.join(__dirname, 'words.json');
const LOG_FILE     = path.join(__dirname, 'log.json');

// ─── Utilitários de configuração ──────────────────────────────────────────────

/** Lê a lista de domínios bloqueados do arquivo blocked.json */
function loadBlocked() {
  try {
    const data = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
    return (data.bloqueados || []).map(d => d.toLowerCase());
  } catch (err) {
    console.warn('[AVISO] Não foi possível ler blocked.json:', err.message);
    return [];
  }
}

/** Lê o dicionário de substituições do arquivo words.json */
function loadWords() {
  try {
    return JSON.parse(fs.readFileSync(WORDS_FILE, 'utf8'));
  } catch (err) {
    console.warn('[AVISO] Não foi possível ler words.json:', err.message);
    return {};
  }
}

// ─── Log de acessos ───────────────────────────────────────────────────────────

/**
 * Registra uma requisição no arquivo log.json
 * @param {string} url    - URL solicitada
 * @param {string} acao   - 'permitido' | 'bloqueado' | 'filtrado' | 'tunnel' | 'erro'
 */
function logAccess(url, acao) {
  const entry = {
    timestamp: new Date().toISOString(),
    url,
    acao,
  };

  let logs = [];
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    logs = JSON.parse(raw);
  } catch {
    // Arquivo ainda não existe ou está vazio — começa do zero
  }

  logs.push(entry);

  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch (err) {
    console.error('[ERRO] Não foi possível gravar log:', err.message);
  }

  console.log(`[${entry.timestamp}] ${acao.toUpperCase().padEnd(10)} ${url}`);
}

// ─── Filtro de conteúdo ───────────────────────────────────────────────────────

/**
 * Substitui palavras no HTML de forma case-insensitive.
 * Retorna o conteúdo (possivelmente modificado) e um flag indicando se houve substituição.
 *
 * @param {string} html   - Conteúdo HTML original
 * @param {Object} words  - Objeto { palavra: substituto, ... }
 * @returns {{ content: string, wasFiltered: boolean }}
 */
function filterContent(html, words) {
  let content = html;
  let wasFiltered = false;

  for (const [word, replacement] of Object.entries(words)) {
    // Escapa caracteres especiais de regex na palavra-chave
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');

    if (regex.test(content)) {
      content = content.replace(regex, replacement);
      wasFiltered = true;
    }
  }

  return { content, wasFiltered };
}

// ─── Página de bloqueio ───────────────────────────────────────────────────────

/**
 * Gera uma página HTML estilizada informando que o acesso foi bloqueado.
 * @param {string} domain - Domínio bloqueado
 * @returns {string} HTML da página de bloqueio
 */
function buildBlockedPage(domain) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Acesso Bloqueado — Proxy FURG</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0f172a;
      font-family: 'Segoe UI', system-ui, sans-serif;
      color: #e2e8f0;
    }

    .card {
      background: #1e293b;
      border: 1px solid #ef4444;
      border-radius: 16px;
      padding: 48px 56px;
      max-width: 520px;
      width: 90%;
      text-align: center;
      box-shadow: 0 0 40px rgba(239, 68, 68, 0.2);
    }

    .icon {
      font-size: 64px;
      margin-bottom: 24px;
      display: block;
    }

    h1 {
      font-size: 1.8rem;
      color: #ef4444;
      margin-bottom: 12px;
      letter-spacing: -0.5px;
    }

    p {
      color: #94a3b8;
      line-height: 1.6;
      margin-bottom: 8px;
    }

    .domain {
      display: inline-block;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 6px 16px;
      font-family: monospace;
      font-size: 1rem;
      color: #f87171;
      margin: 12px 0 20px;
    }

    .footer {
      margin-top: 28px;
      font-size: 0.8rem;
      color: #475569;
      border-top: 1px solid #334155;
      padding-top: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">🚫</span>
    <h1>Acesso Bloqueado</h1>
    <p>O domínio abaixo está na lista negra deste proxy.</p>
    <div class="domain">${domain}</div>
    <p>Se você acredita que este bloqueio é um erro, entre em contato com o administrador da rede.</p>
    <div class="footer">
      Proxy FURG — Sistemas para Internet 2 &bull; ${new Date().toLocaleString('pt-BR')}
    </div>
  </div>
</body>
</html>`;
}

// ─── Handler principal (requisições HTTP) ─────────────────────────────────────

/**
 * Processa requisições do tipo:
 *   GET http://localhost:5000/http://www.exemplo.com
 *
 * O caminho da requisição começa com "/" seguido da URL alvo completa.
 */
function handleRequest(req, res) {
  // Extrai a URL alvo removendo o "/" inicial
  const targetUrl = req.url.slice(1);

  // Valida o formato esperado
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Requisição inválida. Use: http://localhost:5000/http://site.com');
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('URL malformada.');
    return;
  }

  const domain = parsedUrl.hostname.toLowerCase();

  // ── 1. Verifica lista negra ──────────────────────────────────────────────
  const blocked = loadBlocked();
  if (blocked.includes(domain)) {
    logAccess(targetUrl, 'bloqueado');
    const page = buildBlockedPage(domain);
    res.writeHead(403, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(page, 'utf8'),
    });
    res.end(page);
    return;
  }

  // ── 2. Prepara a requisição ao servidor de origem ────────────────────────
  const isHttps  = targetUrl.startsWith('https://');
  const lib      = isHttps ? https : http;
  const port     = parsedUrl.port
    ? parseInt(parsedUrl.port, 10)
    : isHttps ? 443 : 80;

  // Repassa os headers originais, ajustando o Host
  const forwardHeaders = { ...req.headers };
  forwardHeaders['host'] = parsedUrl.host;
  // Remove encoding de compressão para poder modificar o HTML sem problemas
  delete forwardHeaders['accept-encoding'];

  const options = {
    hostname : parsedUrl.hostname,
    port,
    path     : parsedUrl.pathname + parsedUrl.search,
    method   : req.method,
    headers  : forwardHeaders,
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] || '';
    const isHtml      = contentType.includes('text/html');

    if (isHtml) {
      // Coleta o corpo completo para poder aplicar o filtro de palavras
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        const rawHtml = Buffer.concat(chunks).toString('utf8');

        const words = loadWords();
        const { content, wasFiltered } = filterContent(rawHtml, words);

        logAccess(targetUrl, wasFiltered ? 'filtrado' : 'permitido');

        // Monta os headers de resposta, atualizando Content-Length
        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders['content-encoding'];   // conteúdo não está comprimido
        delete responseHeaders['transfer-encoding'];  // usaremos content-length fixo
        responseHeaders['content-length'] = Buffer.byteLength(content, 'utf8').toString();
        responseHeaders['content-type']   = 'text/html; charset=utf-8';

        res.writeHead(proxyRes.statusCode, responseHeaders);
        res.end(content, 'utf8');
      });
    } else {
      // Conteúdo binário (imagens, JS, CSS…): repassa direto sem modificação
      logAccess(targetUrl, 'permitido');
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    logAccess(targetUrl, 'erro');
    console.error('[ERRO] Falha ao conectar ao servidor de origem:', err.message);

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Erro de proxy: não foi possível acessar ${domain}.\n${err.message}`);
    }
  });

  // Encaminha o corpo da requisição original (necessário para POST, PUT, etc.)
  req.pipe(proxyReq);
}

// ─── Handler CONNECT (tunelamento HTTPS — desafio bônus) ─────────────────────

/**
 * O método CONNECT é usado pelo navegador para estabelecer túneis HTTPS.
 * O proxy abre uma conexão TCP direta com o servidor de destino e
 * espelha os dados em ambas as direções — sem inspecionar o conteúdo cifrado.
 */
function handleConnect(req, clientSocket, head) {
  const [hostname, portStr] = req.url.split(':');
  const port = parseInt(portStr, 10) || 443;

  logAccess(`CONNECT ${req.url}`, 'tunnel');

  // Conecta ao servidor de destino
  const serverSocket = net.connect(port, hostname, () => {
    // Informa ao cliente que o túnel foi estabelecido
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Encaminha dados iniciais (se houver)
    if (head && head.length > 0) serverSocket.write(head);

    // Espelha o tráfego em ambas as direções
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on('error', (err) => {
    console.error('[TUNNEL ERRO]', err.message);
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });

  clientSocket.on('error', (err) => {
    console.error('[SOCKET CLIENTE ERRO]', err.message);
    serverSocket.destroy();
  });
}

// ─── Criação e inicialização do servidor ─────────────────────────────────────

const server = http.createServer(handleRequest);

// Registra o handler CONNECT para suporte ao bônus de HTTPS
server.on('connect', handleConnect);

server.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  Proxy rodando em http://localhost:${PORT}  ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('Exemplo de uso:');
  console.log(`  http://localhost:${PORT}/http://example.com\n`);
});
