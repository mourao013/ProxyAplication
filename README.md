Web Proxy com Controle de Conteúdo

Trabalho do Primeiro Bimestre — Sistemas para Internet 2 (Turma U, 2026/1)  
Prof. Dr. André Prisco Vargas — C3/FURG
Pedro Henrique e Carlos Mourão

---

Tecnologia escolhida: Node.js

Justificativa

A implementação foi feita em Node.js usando exclusivamente módulos nativos (http, https, net, fs, path) — sem dependências externas. A escolha se justifica por alguns motivos:

- I/O não-bloqueante: o modelo de event loop do Node.js é naturalmente adequado para proxies, que são essencialmente intermediadores de I/O. Enquanto aguarda a resposta de um servidor de origem, o processo não bloqueia — pode atender outras requisições.
- Streams nativas: o Node.js permite `pipe()` direto entre streams HTTP, o que torna o modo transparente extremamente eficiente: o conteúdo é repassado em chunks sem precisar carregar tudo na memória.
- Zero dependências**: os módulos http, https e net já estão disponíveis nativamente.
-

### Vantagens percebidas

- Pipe de streams torna o repasse de binários (imagens, JS, CSS) trivial e eficiente.
- O módulo `net` facilita o tunelamento TCP para o desafio CONNECT.
- Código mais enxuto comparado a um framework completo (Flask requereria mais boilerplate para lidar com streaming).

### Dificuldades

- Gerenciar corretamente os headers (`Content-Length`, `Content-Encoding`, `Transfer-Encoding`) ao modificar o corpo HTML exigiu atenção: remover o `accept-encoding` da requisição de saída evita que o servidor retorne conteúdo comprimido (gzip), que não poderia ser modificado como texto.
- O tratamento de erros em múltiplos eventos (socket, request, pipe) requer cuidado para não tentar escrever na resposta depois que ela já foi enviada.

---

## Pré-requisitos

- [Node.js](https://nodejs.org/) v18 ou superior (sem dependências externas)

## Estrutura do projeto

```
web-proxy/
├── proxy.js        # Servidor proxy principal
├── blocked.json    # Lista de domínios bloqueados
├── words.json      # Dicionário de substituição de palavras
├── log.json        # Log de acessos (gerado automaticamente)
├── package.json
└── README.md
```

---

## Configuração

### Domínios bloqueados — `blocked.json`

Adicione os domínios que devem ser bloqueados no array `bloqueados`:

```json
{
  "bloqueados": [
    "www.sitex.com",
    "redes-sociais.net",
    "joguinhos.io"
  ]
}
```

> O proxy compara apenas o **hostname** da URL (sem `http://`, sem caminhos).

### Filtro de palavras — `words.json`

Cada chave é a palavra a ser substituída; o valor é o texto de substituição:

```json
{
  "foda":   "diabos",
  "merda":  "macacos me mordam",
  "idiota": "ingênuo"
}
```

> A substituição é **case-insensitive**: `Merda`, `MERDA` e `merda` são tratadas da mesma forma.

---

## Execução

```bash
# Opção 1 — diretamente
node proxy.js

# Opção 2 — via npm
npm start

# Opção 3 — modo watch (reinicia ao salvar arquivos, Node.js v18+)
npm run dev
```

O proxy ficará disponível em `http://localhost:5000`.

---

## Como usar

Abra o navegador (ou use `curl`) e acesse URLs no formato:

```
http://localhost:5000/<URL-ALVO>
```

### Exemplos

```bash
# Acesso transparente
curl http://localhost:5000/http://example.com

# Site bloqueado (retorna página personalizada)
curl http://localhost:5000/http://www.sitex.com

# Conteúdo com palavras filtradas
curl http://localhost:5000/http://algum-site-com-palavroes.com
```

Para usar o proxy no navegador, configure-o nas preferências de rede como proxy HTTP manual:
- **Host:** `localhost`
- **Porta:** `5000`

---

## Comportamento detalhado

| Situação | Ação | Log |
|---|---|---|
| Domínio na lista negra | Retorna página HTML de bloqueio (403) | `bloqueado` |
| HTML com palavrões | Substitui e entrega o conteúdo modificado | `filtrado` |
| Qualquer outro conteúdo | Repassa sem modificação | `permitido` |
| Tunelamento HTTPS (CONNECT) | Cria túnel TCP transparente | `tunnel` |

---

## Log de acessos

Cada requisição é registrada automaticamente em `log.json`:

```json
[
  {
    "timestamp": "2026-05-26T10:00:01.000Z",
    "url": "http://example.com",
    "acao": "permitido"
  },
  {
    "timestamp": "2026-05-26T10:00:15.000Z",
    "url": "http://www.sitex.com/pagina",
    "acao": "bloqueado"
  }
]
```

---

## Desafio bônus: suporte ao método CONNECT (HTTPS)

O proxy implementa o método HTTP `CONNECT`, que permite ao navegador estabelecer **túneis TCP** para conexões HTTPS.

Quando o navegador quer acessar `https://github.com`, ele envia:

```
CONNECT github.com:443 HTTP/1.1
```

O proxy abre uma conexão TCP com `github.com:443` e espelha o tráfego em ambas as direções usando `socket.pipe()`. O conteúdo permanece cifrado — o proxy não consegue (nem tenta) inspecioná-lo.

Para ativar esse comportamento, basta configurar o proxy no navegador nas preferências de rede (conforme descrito acima).

---

## Por que o filtro de palavras não funciona em HTTPS?

Quando um site usa HTTPS, todo o conteúdo HTTP (incluindo o HTML) é cifrado com TLS antes de sair do servidor. O proxy recebe bytes cifrados que **não fazem sentido sem a chave privada do servidor**.

Para que o filtro funcionasse em HTTPS, o proxy precisaria realizar um ataque _man-in-the-middle_ legítimo (também chamado de **SSL inspection**):

1. Gerar um certificado falso para cada domínio acessado, assinado por uma CA própria.
2. Instalar essa CA como **confiável** no navegador/sistema operacional.
3. Decifrar o TLS com o certificado falso, inspecionar e modificar o HTML, e re-cifrar para o cliente.

Esse processo é usado em proxies corporativos (como Zscaler, Squid com SSL Bump), mas exige que o cliente confie na CA do proxy — o que não acontece por padrão.

---

## Uso de IA

*(Preencher conforme o uso real da dupla durante o desenvolvimento)*

---

## Referências

- [MDN — HTTP](https://developer.mozilla.org/pt-BR/docs/Web/HTTP)
- [MDN — Proxies e tunelamento](https://developer.mozilla.org/en-US/docs/Web/HTTP/Proxy_servers_and_tunneling)
- [RFC 7230 — HTTP/1.1](https://datatracker.ietf.org/doc/html/rfc7230)
- [Node.js — módulo http](https://nodejs.org/api/http.html)
- [Node.js — módulo net](https://nodejs.org/api/net.html)
