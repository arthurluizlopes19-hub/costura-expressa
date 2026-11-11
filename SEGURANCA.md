# Segurança do app Costura Expressa

Auditoria feita em 10/11/2026. Este arquivo explica como o app é protegido, o que foi corrigido e o que ainda depende de configuração no Firebase.

## Arquitetura

- **Site estático** no GitHub Pages (HTML, CSS e JavaScript, sem servidor próprio).
- **Banco:** Google Firebase Firestore (NoSQL, sem SQL). O controle de acesso fica nas **Regras do Firestore** (`firestore.rules`), que fazem o papel do RLS.
- **Login em duas camadas:**
  1. O aparelho entra uma vez com o **e-mail e a senha do ateliê** (Firebase Authentication). Sem isso o banco recusa tudo.
  2. Cada pessoa escolhe o nome e digita o **PIN** dela (Gerência, Administração, Atendente ou Costureira).
- **Bibliotecas:** Firebase 10.12.2 (gstatic), jsPDF 4.2.1, html2canvas 1.4.1, jsQR 1.4.0 e qrcodejs, todas servidas pelo próprio site, exceto o Firebase.

Por isso alguns itens comuns em auditorias não se aplicam: não há SQL (nem SQL Injection), não há servidor nem cookies próprios (HttpOnly/SameSite) e não há variáveis de ambiente secretas. A chave `apiKey` do `firebase-config.js` é pública por natureza: ela só identifica o projeto, e quem protege os dados são as regras.

## O que foi corrigido

| # | Problema encontrado | Gravidade | Correção |
|---|---|---|---|
| 1 | Regras liberavam leitura e gravação de **todo o banco para qualquer login**, inclusive o **anônimo**, que qualquer pessoa consegue criar. | Crítica | As regras agora exigem login por **e-mail e senha** (`sign_in_provider == 'password'`) e negam o resto. |
| 2 | A coleção `publico` podia ser **listada inteira** por qualquer pessoa, com nome da cliente, serviços e valores de todos os pedidos. | Alta | Só abre por código exato (`get`). Listar (`list`) é proibido. |
| 3 | Sem validação no banco: dava para gravar campos e valores quaisquer (mass assignment), como uma função inventada ou um preço negativo. | Alta | Cada coleção aceita só os campos e formatos que o app usa, com limites de tamanho. |
| 4 | PIN guardado como **SHA-256 simples**, que se testa muito rápido. | Alta | **PBKDF2-SHA256 com 210 mil iterações** e sal aleatório (WebCrypto). PINs antigos continuam funcionando e são convertidos no primeiro login certo. |
| 5 | PIN sem limite de tentativas. | Média | Depois de 5 erros a pessoa espera 30 s, depois 1 min, 2 min... até 15 min. |
| 6 | `pedido.html` fazia login anônimo (motivo do item 1). | Média | Login anônimo removido. A página lê só o documento público pelo código. |
| 7 | Sem política de conteúdo (CSP): uma injeção de HTML poderia rodar script. | Média | CSP sem `unsafe-inline` para scripts. O código foi movido para `app.js` e `pedido.js`, e só rodam scripts do próprio site e do Firebase. |
| 8 | O app podia ser aberto dentro de iframe de outro site (clickjacking). | Média | Bloqueio por script, e por `X-Frame-Options` e `frame-ancestors` no Firebase Hosting. |
| 9 | Arquivos de áudio aceitos só pela extensão. Arquivos guardados voltavam com o tipo informado (um HTML disfarçado viraria página). | Média | O áudio é conferido pela **assinatura dos bytes** (máx. 6 MB). Fotos são **recodificadas em JPEG** (máx. 30 MB na entrada). Na leitura, só tipos de imagem e áudio conhecidos são aceitos, e o resto vira binário inerte. |
| 10 | jsPDF 2.5.1 com falhas conhecidas (CVE-2025-29907, CVE-2025-57810). | Média | Atualizado para **jsPDF 4.2.1**. |
| 11 | IDs do banco entravam no HTML sem escape em 4 pontos. | Baixa | Escapados. |
| 12 | Atalho antigo de login "Dono" sem PIN (desativado, mas o código existia). | Baixa | Removido. |
| 13 | Mensagem de erro genérica escondia a causa real. | Baixa | Mostra o código do erro, sem dados internos. |

## Recursos de segurança ativos

- Regras do Firestore com provedor obrigatório, validação de campos e negação padrão (`firestore.rules`).
- PBKDF2 para os PINs e limite de tentativas por pessoa.
- CSP, `Referrer-Policy` e proteção contra iframe nas páginas (`index.html` e `pedido.html`).
- Cabeçalhos HTTP reais no Firebase Hosting (`firebase.json`): HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` (só câmera e microfone), `Cross-Origin-Opener-Policy` e CSP.
- HTTPS: o domínio `github.io` força HTTPS e está na lista de pré-carregamento de HSTS dos navegadores. A CSP ainda usa `upgrade-insecure-requests`.
- Escape de todo texto digitado antes de ir para a tela (`esc()`). Teste: nome e observação com `<img onerror>` e `<script>` aparecem como texto.

## Testes executados

Feitos com navegador Chromium automatizado, com a CSP ativa:

- Login: bloqueio depois de 5 PINs errados (inclusive com o PIN certo durante a espera), login com PBKDF2 e conversão de PIN antigo. **Passou.**
- XSS: nome e observação maliciosos aparecem como texto e nenhum alerta dispara. **Passou.**
- CSP: um script inline injetado, um script externo e um `onerror` injetado foram todos bloqueados. **Passou.**
- Iframe: o app aberto dentro de outro site se apaga. **Passou.**
- Uploads: foto aceita e recodificada, áudio WAV aceito, arquivo HTML renomeado para `.mp3` recusado. **Passou.**
- PDF 80 mm com jsPDF 4.2.1, pedido completo, prioridade, pronto e edição de cliente, sem erros de JavaScript. **Passou.**
- Regras: os 18 documentos gravados pelo app no teste passam nas regras (conferidos com uma cópia das regras em Python). 9 tentativas de ataque foram negadas, entre elas função inventada, PIN em texto, campo extra, preço negativo, status falso e arquivo gigante. **Passou.**
- Dependências: `npm audit` do Firebase 10.12.2 aponta falhas só em pacotes de Node.js (undici, grpc, busboy), que **não vão para o navegador**.

**Limite dos testes:** o emulador oficial do Firestore não pôde ser baixado aqui, então as regras não rodaram no motor real do Google. Antes de publicar, confira no **Playground de regras** do console (passo 3 abaixo).

## O que ainda depende de você (configuração externa)

1. **Bloquear a criação de contas** (obrigatório): Firebase Console > Authentication > Configurações > Ações do usuário > desmarque **Ativar criação (inscrição)**. Sem isso, qualquer pessoa cria uma conta de e-mail e senha com a chave pública e entra no banco.
2. **Desativar o login anônimo**: Authentication > Método de login > **Anônimo** > Desativar.
3. **Publicar as regras**: Firestore Database > Regras > cole o conteúdo de `firestore.rules`. Use o **Playground** para testar um `get` em `pedidos/CE-ABCDEF` com usuário autenticado (provedor `password`) e sem usuário. Depois clique em **Publicar**.
4. **Restringir a chave da API** (recomendado): Google Cloud Console > APIs e serviços > Credenciais > a chave do navegador > restrição de **Referenciadores HTTP** com o endereço do site, e restrição de APIs para Identity Toolkit, Token Service e Cloud Firestore.
5. **App Check com reCAPTCHA** (recomendado, proteção contra robôs): precisa de uma chave reCAPTCHA criada no console. Depois ela é ligada no app.
6. **Senha da conta do ateliê**: use uma senha longa e única e ative a verificação em duas etapas na conta Google dona do projeto.

## Riscos que continuam (limites da arquitetura)

- **As funções (Costureira, Atendente...) são controladas no app, não no banco.** Todos os aparelhos usam a mesma conta do ateliê, então quem tem um aparelho liberado e sabe usar as ferramentas do navegador consegue ler os dados de todas as funções, como os valores. Para separar no servidor, cada pessoa precisaria ter a própria conta no Firebase (ou funções de servidor, no plano pago).
- **O PIN tem só de 4 a 6 números.** O limite de tentativas vale no app, mas quem já tem acesso ao banco pode testar todos os PINs fora dele. O PBKDF2 deixa isso lento, mas não impossível. PINs de 6 dígitos são mais fortes.
- **O GitHub Pages não permite cabeçalhos HTTP próprios.** HSTS, `X-Content-Type-Options` e `frame-ancestors` só valem como cabeçalho se o site for publicado no Firebase Hosting (o `firebase.json` já está pronto). A ação de deploy precisa do segredo `FIREBASE_SERVICE_ACCOUNT` no GitHub.
- **O Firebase continua na versão 10.12.2.** Não há falha conhecida que afete o navegador, e atualizar para a 12 deve ser feito com teste no banco real.
- **O histórico do Git é público** e os commits mostram o e-mail do autor. Não há senha nem chave privada no histórico (varredura feita em 59 commits).
