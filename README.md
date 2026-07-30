# 💰 Minha Finança — Painel Financeiro Pessoal com IA

Sistema financeiro pessoal em HTML + Firebase, com inteligência artificial (Claude) para ler comprovantes, planejar dívidas e traçar seu caminho até o primeiro milhão.

**O que ele faz:**

- Registro de entradas e saídas com categorias, filtro por mês e saldo automático
- 📸 **Comprovante IA**: fotografe um comprovante (PIX, cartão, boleto, nota) e a IA extrai valor, data, estabelecimento e categoria — você só confirma
- 📉 **Planejamento de dívidas**: calcula o máximo que você pode negociar por mês sem apertar o orçamento, com estratégia de quitação gerada por IA
- 📈 **Investimentos**: registro de aportes e carteira por tipo de ativo
- 🎯 **Plano Milionário**: meta de R$ 1 milhão em 5 anos, com aporte mensal necessário calculado por juros compostos e plano de ação gerado por IA
- 🤖 **Consultor IA**: chat que conhece seus números reais e ajuda nas decisões
- 👥 Uso compartilhado (você + esposa/sócio), dados em tempo real no Firebase
- Funciona no computador e no celular, com tema claro e escuro

---

## Passo 1 — Criar o projeto no Firebase (≈ 10 min)

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) e clique em **Adicionar projeto**. Dê um nome (ex.: `minha-financa`). Pode desativar o Google Analytics.
2. Na tela inicial do projeto, clique no ícone **`</>` (Web)** para registrar um app da Web. Dê um apelido (ex.: `painel`) e clique em **Registrar app**.
3. O Firebase vai mostrar um bloco `const firebaseConfig = { ... }`. **Copie esses valores** e cole no arquivo **`firebase-config.js`** deste projeto, substituindo os textos `COLE_AQUI` / `SEU-PROJETO`.

### Ativar o login com Google

4. No menu lateral: **Criação → Authentication → Vamos começar**.
5. Aba **Sign-in method** → **Google** → ative e salve.
6. Ainda em Authentication, abra **Settings → Domínios autorizados** e adicione o domínio do seu GitHub Pages (ex.: `seuusuario.github.io`). `localhost` já vem liberado para testes.

### Criar o banco de dados (Firestore)

7. Menu lateral: **Criação → Firestore Database → Criar banco de dados**.
8. Escolha o modo **produção** e a região `southamerica-east1` (São Paulo).
9. Abra a aba **Regras**, apague tudo e cole o conteúdo do arquivo **`firestore.rules`** deste projeto. Clique em **Publicar**.

> 🔒 As regras garantem que só os e-mails convidados enxergam os dados. As chaves do `firebase-config.js` podem ficar públicas no GitHub sem problema — a segurança vem das regras, não do sigilo das chaves.

---

## Passo 2 — Publicar no GitHub Pages (≈ 5 min)

1. Crie um repositório no [github.com](https://github.com) (ex.: `minha-financa`). Pode ser **público ou privado** (Pages em repositório privado exige plano pago; público funciona no plano gratuito).
2. Envie estes arquivos para o repositório: `index.html`, `app.js`, `firebase-config.js` (já preenchido), `firestore.rules` e `README.md`.
   - Pelo site: **Add file → Upload files** e arraste os arquivos.
3. No repositório: **Settings → Pages → Branch: `main` / pasta `/ (root)` → Save**.
4. Em 1–2 minutos seu sistema estará no ar em `https://seuusuario.github.io/minha-financa/`.
5. Confirme que esse domínio foi adicionado nos **Domínios autorizados** do Firebase (passo 1.6).

Para atualizar o sistema depois, basta substituir os arquivos no repositório.

---

## Passo 3 — Ativar a IA (Claude)

1. Crie uma conta em [console.anthropic.com](https://console.anthropic.com) e adicione créditos (US$ 5 já duram meses para uso pessoal).
2. Vá em **API Keys → Create key** e copie a chave (`sk-ant-...`).
3. No sistema, abra **Configurações → Inteligência Artificial**, cole a chave e clique em **Testar conexão**.

> 🔑 A chave fica salva **apenas no seu navegador** (localStorage). Ela nunca é enviada ao GitHub nem ao Firebase. Cada dispositivo (seu notebook, seu celular, o celular da sua esposa) precisa colar a chave uma vez.

Modelos disponíveis nas Configurações: **Sonnet** (recomendado), **Haiku** (mais barato) e **Opus** (análises mais profundas).

---

## Passo 4 — Convidar a segunda pessoa

1. Entre no sistema com seu Google.
2. **Configurações → Quem usa este painel → Convidar** e digite o Gmail da pessoa.
3. Ela acessa o mesmo link e entra com o Google dela — os dados são compartilhados em tempo real.

---

## Primeiros passos recomendados

1. **Configurações**: confira a meta de renda mensal, o % para investir e o % máximo para dívidas.
2. **Plano 5 Anos → Ajustar meta**: confirme o valor (R$ 1.000.000) e a data de início.
3. Cadastre suas **dívidas atuais** (com juros, se souber — a IA usa isso na estratégia).
4. Registre as **entradas e saídas** do mês (ou fotografe os comprovantes na aba Comprovante IA).
5. Depois de alguns registros, converse com o **Consultor IA** — quanto mais dados, melhores as respostas.

## Custos

| Serviço | Custo |
|---|---|
| Firebase (Auth + Firestore) | R$ 0 no plano gratuito (Spark) — de sobra para uso pessoal |
| GitHub Pages | R$ 0 |
| API Claude | pré-pago; leitura de um comprovante custa ~US$ 0,01 com Sonnet |

## Estrutura dos dados (Firestore)

```
households/{id}
 ├─ name, owner, members[]
 ├─ transactions/  → entradas e saídas
 ├─ debts/         → dívidas
 ├─ investments/   → aportes e resgates
 └─ meta/settings  → parâmetros e meta
```

---

*Este sistema é uma ferramenta de organização. As análises da IA são sugestões e não substituem um assessor de investimentos certificado.*
