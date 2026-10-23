# Costura Expressa

App de pedidos do ateliê **Costura Expressa** (Galeria Jaqueira Park Center, R. do Futuro, 913, Graças, Recife/PE).

![Logo](logo-costura-expressa.png)

## O que o app faz

- **Login por função**: Administração, Atendente e Costureira, cada uma com senha de 4 a 6 números.
- **Atendimento**: dados da cliente, seleção dos serviços com valores, observações, fotos da peça e áudio para a costureira. Ao finalizar, gera a nota com QR code.
- **Costureiras**: escaneiam o QR (ou digitam o código), ouvem o áudio, veem as fotos e pegam o pedido registrando nome e foto.
- **Logística**: prazos (atrasados, hoje, amanhã), peças por costureira, local onde cada peça está guardada e prontos para retirada.
- **Serviços** e **Equipe**: cadastro da tabela de preços e dos acessos.
- **Impressão**: nota como imagem para imprimir e PDF em A4 ou térmica 80 mm.

## Onde o app funciona

O `index.html` foi feito para rodar como Artifact no Claude (claude.ai). Os pedidos, fotos, áudios e acessos ficam guardados no banco de dados do Claude, usado pelo app por meio de `window.claude`.

Aberto fora do Claude (por exemplo no GitHub Pages), a tela abre, mas não consegue salvar nem carregar pedidos. Para funcionar fora do Claude, é preciso trocar o armazenamento por um serviço próprio (por exemplo Firebase ou Supabase).

## Arquivos

- `index.html`: o app completo (HTML, CSS e JavaScript em um arquivo só, com a logo embutida).
- `logo-costura-expressa.png`: logo com fundo transparente.

A nota gerada é um comprovante interno do ateliê e não substitui a NF-e ou NFS-e oficial.
