# Costura Expressa

App de pedidos do ateliê **Costura Expressa** (Galeria Jaqueira Park Center, R. do Futuro, 913, Graças, Recife/PE · WhatsApp (81) 99616-0055).

![Logo](logo-costura-expressa.png)

## O que o app faz

- **Login por função**: Administração, Atendente e Costureira, cada uma com senha de 4 a 6 números.
- **Atendimento**: dados da cliente, serviços com valores, observações, fotos da peça e áudio para a costureira. Ao finalizar, gera a nota com QR code.
- **Costureiras**: escaneiam o QR (ou digitam o código), ouvem o áudio, veem as fotos e pegam o pedido registrando nome e foto.
- **Logística**: prazos (atrasados, hoje, amanhã), peças por costureira, local de cada peça e prontos para retirada.
- **Serviços** e **Equipe**: tabela de preços e acessos.
- **Impressão**: imprimir direto, nota como imagem e PDF em A4 ou térmica 80 mm.

Os dados ficam no **Firebase (Firestore)** do ateliê, no plano gratuito.

## Como colocar no ar

### 1. Criar o Firebase (uma vez)

1. Entre em [console.firebase.google.com](https://console.firebase.google.com) com uma conta Google e crie um projeto (ex.: `costura-expressa`). O Google Analytics pode ficar desligado.
2. **Authentication** > Começar > aba **Método de login** > ative **Anônimo**.
3. **Firestore Database** > Criar banco de dados > escolha a região `southamerica-east1 (São Paulo)` > modo de produção.
4. Na aba **Regras** do Firestore, cole o conteúdo do arquivo `firestore.rules` e publique.
5. Em **Configurações do projeto** (engrenagem) > **Seus apps** > ícone **</>** (Web) > registre o app. Copie o bloco `firebaseConfig`.
6. Cole esses valores no arquivo `firebase-config.js` deste repositório.

### 2. Publicar no GitHub Pages

1. No repositório: **Settings > Pages**.
2. Em *Source*, escolha **Deploy from a branch**, branch **main**, pasta **/ (root)**, e salve.
3. Em 1 ou 2 minutos o link aparece no topo da página de Pages.

No plano gratuito do GitHub, o Pages só funciona em repositório **público**. A configuração do Firebase não é segredo; o que protege os dados são as regras do Firestore.

### 3. Primeiro acesso

Abra o link, crie o acesso de **Administração** e cadastre a equipe na aba **Equipe** e os preços na aba **Serviços**.

## Arquivos

- `index.html`: o app.
- `firebase-config.js`: configuração do seu projeto Firebase.
- `firestore.rules`: regras de acesso do banco.
- `logo-costura-expressa.png`: logo.

O login por senha organiza o ateliê, mas não é uma proteção forte: quem tiver o link pode abrir o app. A nota é um comprovante interno e não substitui a NF-e/NFS-e oficial.
