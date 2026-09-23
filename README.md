# Calculadora

Versão estática da calculadora, pronta para publicação no GitHub Pages.

## Publicar no GitHub Pages

1. Crie um repositório no GitHub.
2. Envie todos os arquivos desta pasta para a raiz do repositório.
3. Em **Settings > Pages**, selecione **Deploy from a branch**, escolha a branch principal e a pasta `/ (root)`.
4. Abra a URL fornecida pelo GitHub.

O arquivo `index.html` é a entrada do site. O manifesto PWA usa o nome **Calculadora** e os números exibem pontos como separadores de milhares, por exemplo `123.456.789`.

## Modos secretos

Digite um número e toque no relógio para salvar o número e selecionar o truque clássico. Digite um número e toque no ícone da calculadora para salvar o número e selecionar o novo truque do botão `+`. O número e o último modo escolhido permanecem salvos mesmo depois de fechar o aplicativo.

Uma pressão longa no botão `,` revela temporariamente o número salvo. Uma pressão curta continua inserindo o separador decimal normalmente. No modo novo, um número já digitado pode permanecer visível; toque em `+`, digite o número do espectador e pressione `=` para concluir. Nesse momento, a expressão é ajustada para que o resultado seja o número configurado. Uma pressão longa no `AC` apaga o número salvo, o modo e o estado da calculadora. Um toque curto no `AC` mantém o comportamento normal.
